import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import { buildResponse } from "@/utils/api-response-util";
import { generateId } from "@/utils";
import { RateService } from "./rate.service";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import {
    LedgerType,
    NetworkTypes,
    OrderCategory,
    OrderStatus,
    QueueReason,
    User,
} from "@prisma/client";
import { IncompleteAccountSetupException, RateLimitExceededException, GeneralTransactionException } from "../errors";
import {
    CancelWithdrawerRequestDto,
    GetCryptoWithdrawerFeeDto,
    WithdrawerRequestDto,
} from "../dtos";
import { WsGateway } from "../gateway/v1";
import { TradeHelpersService } from "./trade-helpers.service";
import { WalletAddressService } from "./wallet-address.service";
import { getStreamlinedStatus } from "../interfaces/trade";
import { RateLimiterService } from "@/modules/core/rate-limit/services/rate-limiter.service";
import { LedgerService } from "./ledger/ledger.service";
import { WithdrawalQueueService } from "./ledger/withdrawal-queue.service";
import { DistributedLockService } from "@/modules/core/redisCache/services/distributed-lock.service";
import { SweepService } from "./ledger/sweep.service";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { Decimal } from "@prisma/client/runtime/library";
import { TransactionMonitorService } from "./ledger/transaction-monitor.service";

// Withdrawal rate limits: configurable via environment variables
// Default: 5 withdrawals per hour per user
const WITHDRAWAL_RATE_LIMIT = Number.parseInt(process.env.WITHDRAWAL_RATE_LIMIT || "5", 10);
const WITHDRAWAL_RATE_WINDOW_SECONDS = Number.parseInt(process.env.WITHDRAWAL_RATE_WINDOW_SECONDS || "3600", 10); // 1 hour default

// Stuck order thresholds: auto-fail orders older than these durations
const STUCK_ORDER_SUBMITTED_THRESHOLD_MS = Number.parseInt(process.env.STUCK_ORDER_SUBMITTED_THRESHOLD_MS || String(30 * 60 * 1000), 10); // 30 min
const STUCK_ORDER_PROCESSING_THRESHOLD_MS = Number.parseInt(process.env.STUCK_ORDER_PROCESSING_THRESHOLD_MS || String(2 * 60 * 60 * 1000), 10); // 2 hours

/**
 * Send Service
 * 
 * Handles all crypto send/withdrawal operations including:
 * - Creating withdrawal requests
 * - Calculating withdrawal fees
 * - Canceling pending withdrawals
 * - Rate limiting (5/hour/user, 1 pending/currency)
 */
@Injectable()
export class SendService {
    private readonly logger = new Logger("SendService");
    private readonly evmNetworks = new Set<NetworkTypes>([
        NetworkTypes.erc20,
        NetworkTypes.bep20,
        NetworkTypes.polygon,
        NetworkTypes.optimism,
        NetworkTypes.arbitrum,
        NetworkTypes.base,
        NetworkTypes.celo,
    ]);

    constructor(
        private readonly prisma: PrismaService,
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService,
        private readonly wsGateway: WsGateway,
        private readonly tradeHelpers: TradeHelpersService,
        private readonly walletAddressService: WalletAddressService,
        private readonly rateLimiter: RateLimiterService,
        private readonly ledgerService: LedgerService,
        private readonly withdrawalQueueService: WithdrawalQueueService,
        private readonly sweepService: SweepService,
        private readonly slackWebhookService: SlackWebhookService,
        private readonly rateService: RateService,
        private readonly transactionMonitor: TransactionMonitorService,
        private readonly notificationDispatcher: NotificationDispatcher,
        private readonly distributedLockService: DistributedLockService
    ) { }

    /**
     * Checks withdrawal rate limits
     * - Max 5 withdrawals per hour per user
     * - Max 1 pending withdrawal per currency per user
     */
    private async checkWithdrawalRateLimits(
        userId: number,
        currency: string
    ): Promise<{ allowed: boolean; reason?: string }> {
        // Check hourly rate limit (5/hour)
        const rateLimitResult = await this.rateLimiter.checkLimit(
            `withdrawal:${userId}`,
            {
                limit: WITHDRAWAL_RATE_LIMIT,
                windowSeconds: WITHDRAWAL_RATE_WINDOW_SECONDS,
                keyPrefix: "ratelimit:",
            }
        );

        if (!rateLimitResult.allowed) {
            this.logger.warn(
                `Withdrawal rate limit (hourly) hit | userId: ${userId} | currency: ${currency} | limit: ${WITHDRAWAL_RATE_LIMIT}/hr | retryAfter: ${Math.ceil(rateLimitResult.retryAfter || 0)}s`
            );
            return {
                allowed: false,
                reason: `Rate limit exceeded. You can make ${WITHDRAWAL_RATE_LIMIT} withdrawals per hour. Try again in ${Math.ceil(rateLimitResult.retryAfter || 0)} seconds.`,
            };
        }

        // Check for existing pending withdrawal in same currency
        const pendingWithdrawal = await this.prisma.order.findFirst({
            where: {
                userId,
                orderCategory: OrderCategory.SEND,
                currency: currency.toUpperCase(),
                status: {
                    in: [
                        OrderStatus.submitted,
                        OrderStatus.pending,
                        OrderStatus.processing,
                        OrderStatus.accepted,
                    ],
                },
            },
            select: { id: true, orderReference: true, amount: true, status: true, createdAt: true },
        });

        if (pendingWithdrawal) {
            // Auto-resolve stuck orders: if a pending order is older than the
            // configured threshold, mark it as failed so the user isn't blocked
            // indefinitely by an order that will never complete.
            const orderAgeMs = Date.now() - new Date(pendingWithdrawal.createdAt).getTime();
            const isSubmittedOrPending =
                pendingWithdrawal.status === OrderStatus.submitted ||
                pendingWithdrawal.status === OrderStatus.pending;
            const threshold = isSubmittedOrPending
                ? STUCK_ORDER_SUBMITTED_THRESHOLD_MS
                : STUCK_ORDER_PROCESSING_THRESHOLD_MS;

            if (orderAgeMs > threshold) {
                await this.autoFailStuckOrder(userId, currency, pendingWithdrawal, orderAgeMs, threshold);
                // Order resolved — allow the new withdrawal to proceed
            } else {
                this.logger.warn(
                    `Withdrawal blocked by pending order | userId: ${userId} | currency: ${currency} | orderId: ${pendingWithdrawal.id} | ref: ${pendingWithdrawal.orderReference} | status: ${pendingWithdrawal.status} | age: ${Math.round(orderAgeMs / 60000)}min`
                );
                return {
                    allowed: false,
                    reason: `You already have a pending ${currency.toUpperCase()} withdrawal (${pendingWithdrawal.orderReference}). Please wait for it to complete before making another.`,
                };
            }
        }

        return { allowed: true };
    }

    /**
     * Auto-fails a stuck withdrawal order and releases held funds.
     */
    private async autoFailStuckOrder(
        userId: number,
        currency: string,
        order: { id: number; orderReference: string; amount: any; status: string },
        orderAgeMs: number,
        threshold: number
    ): Promise<void> {
        this.logger.warn(
            `Auto-failing stuck withdrawal order | userId: ${userId} | currency: ${currency} | orderId: ${order.id} | ref: ${order.orderReference} | status: ${order.status} | age: ${Math.round(orderAgeMs / 60000)}min | threshold: ${Math.round(threshold / 60000)}min`
        );

        await this.prisma.order.update({
            where: { id: order.id },
            data: {
                status: OrderStatus.failed,
                reason: `Auto-failed: stuck in ${order.status} for ${Math.round(orderAgeMs / 60000)} min (threshold: ${Math.round(threshold / 60000)} min) at ${new Date().toISOString()}`,
            },
        });

        // Release the held funds back to available balance
        try {
            const releaseResult = await this.ledgerService.releaseHold(
                `withdrawal:${order.orderReference}`,
                false,
                "Stuck order auto-failed"
            );
            if (releaseResult.success) {
                this.logger.log(
                    `Released held funds for stuck order | userId: ${userId} | currency: ${currency} | amount: ${order.amount} | ref: ${order.orderReference}`
                );
            } else {
                this.logger.warn(
                    `No hold entry found to release for stuck order (may have been released already or order predates ledger holds) | userId: ${userId} | orderId: ${order.id} | ref: ${order.orderReference} | error: ${releaseResult.error}`
                );
            }
        } catch (releaseError) {
            // Log but don't block — the order is already marked failed.
            // Manual reconciliation may be needed if hold release fails.
            this.logger.error(
                `Failed to release hold for auto-failed order | userId: ${userId} | orderId: ${order.id} | error: ${releaseError.message}`
            );
        }

        // Notify ops via Slack
        try {
            await this.slackWebhookService.sendAlert(
                "STUCK_WITHDRAWAL",
                {
                    text: `⚠️ Stuck Withdrawal Auto-Failed`,
                    blocks: [
                        {
                            type: "section",
                            text: {
                                type: "mrkdwn",
                                text: `*Order:* ${order.orderReference}\n*User:* ${userId}\n*Currency:* ${currency}\n*Status:* ${order.status}\n*Stuck for:* ${Math.round(orderAgeMs / 60000)} min\n*Action:* Auto-failed, held funds released.`,
                            },
                        },
                    ],
                },
                { alertKey: `stuck_withdrawal:${order.id}` }
            );
        } catch (err) {
            this.logger.debug(`Slack notification failed for stuck withdrawal: ${err}`);
        }
    }

    /**
     * Gets a fee based on amount and fee data structure
     */
    private async getFee(
        amount: number,
        data: any
    ): Promise<{ fee: number; type: string }> {
        if (data.type === "flat" && typeof data.fee === "number") {
            return { fee: data.fee, type: "flat" };
        }

        if (data.type === "percentage" && typeof data.fee === "number") {
            return { fee: (amount * data.fee) / 100, type: "percentage" };
        }

        if (data.type === "range" && Array.isArray(data.fee)) {
            return this.getRangeFee(amount, data.fee);
        }

        // Fallback for simple fee structures
        if (typeof data.fee === "number") {
            return { fee: data.fee, type: "fixed" };
        }

        throw new IncompleteAccountSetupException(
            "Unknown fee structure",
            HttpStatus.INTERNAL_SERVER_ERROR
        );
    }

    /**
     * Resolves fee from a range-based fee schedule.
     */
    private getRangeFee(
        amount: number,
        ranges: Array<{ min: number; max: number; type: string; value: number }>
    ): { fee: number; type: string } {
        for (const range of ranges) {
            if (amount >= range.min && amount < range.max) {
                return range.type === "percentage"
                    ? { fee: (amount * range.value) / 100, type: "percentage" }
                    : { fee: range.value, type: "flat" };
            }
        }

        throw new IncompleteAccountSetupException(
            "Amount is out of range.",
            HttpStatus.BAD_REQUEST
        );
    }

    /**
     * Fetches the withdrawal fee from the provider, wrapping 429 errors
     * into a user-friendly rate-limit message.
     */
    private async fetchWithdrawalFee(
        userId: number,
        amount: number,
        currency: string,
        network: string
    ) {
        try {
            return await this.getCryptoWithdrawerFee({
                amount,
                currency: currency as any,
                network: network as any,
            });
        } catch (feeError) {
            if (feeError?.status === 429 || feeError?.name === "DojahTooManyRequestError") {
                this.logger.warn(
                    `Quidax 429 during fee fetch | userId: ${userId} | currency: ${currency} | error: ${feeError.message}`
                );
                throw new RateLimitExceededException(
                    "Our withdrawal service is temporarily busy. Please try again in a few seconds."
                );
            }
            throw feeError;
        }
    }

    /**
     * Gets the amount converted to Naira for sell/send orders
     */
    private async getAmountInNaira(
        currency: string,
        amount: number
    ): Promise<{ amount: number; rate: number } | null> {
        try {
            const rate = await this.rateService.getAssetRate(currency.toUpperCase());
            // Use buy rate for outgoing (what user sends out)
            return {
                amount: amount * rate.buyRate,
                rate: rate.buyRate,
            };
        } catch {
            return null;
        }
    }

    /**
     * Throws if `destinationAddress` matches any of the sender's own deposit
     * addresses (CryptoWalletAddress or AssetWallet.depositAddress).
     *
     * EVM / TRC20 addresses are compared case-insensitively (EIP-55 checksum
     * can differ) while other address formats are compared as-is.
     */
    private async assertNotOwnDepositAddress(
        userId: number,
        destinationAddress: string,
        currency: string,
    ): Promise<void> {
        const addr = destinationAddress.trim();
        const isEVMOrTRC20 = /^(0x[a-fA-F0-9]{40}|T[1-9A-HJ-NP-Za-km-z]{33})$/.test(addr);

        // 1. Check CryptoWalletAddress table (per-network addresses)
        const ownCryptoAddress = await this.prisma.cryptoWalletAddress.findFirst({
            where: {
                userId,
                ...(isEVMOrTRC20
                    ? { address: { equals: addr, mode: "insensitive" as any } }
                    : { address: addr }),
            },
            select: { address: true, network: true },
        });

        if (ownCryptoAddress) {
            this.logger.warn(
                `Blocked self-send to own deposit address | userId: ${userId} | address: ${addr.slice(0, 10)}... | matchedNetwork: ${ownCryptoAddress.network}`
            );
            throw new IncompleteAccountSetupException(
                "Cannot withdraw to your own deposit address. The funds would return as a new deposit and you would lose the withdrawal fee. Use internal transfer instead.",
                HttpStatus.BAD_REQUEST
            );
        }

        // 2. Fallback: check AssetWallet.depositAddress (older storage)
        const ownWallet = await this.prisma.assetWallet.findFirst({
            where: {
                userId,
                ...(isEVMOrTRC20
                    ? { depositAddress: { equals: addr, mode: "insensitive" as any } }
                    : { depositAddress: addr }),
            },
            select: { depositAddress: true, assetCurrency: true },
        });

        if (ownWallet) {
            this.logger.warn(
                `Blocked self-send to own wallet deposit address | userId: ${userId} | address: ${addr.slice(0, 10)}... | currency: ${ownWallet.assetCurrency}`
            );
            throw new IncompleteAccountSetupException(
                "Cannot withdraw to your own deposit address. The funds would return as a new deposit and you would lose the withdrawal fee. Use internal transfer instead.",
                HttpStatus.BAD_REQUEST
            );
        }
    }

    /**
     * Resolve the network type from the address format when not explicitly provided.
     */
    private resolveNetwork(
        userId: number, 
        explicitNetwork: string | undefined, 
        address: string
    ): NetworkTypes | undefined {
        if (explicitNetwork) return explicitNetwork as NetworkTypes;
        const family = this.inferAddressFamily(address);
        if (family === "unknown") return undefined;

        const familyToNetwork: Record<string, NetworkTypes> = {
            evm: NetworkTypes.erc20,
            trc20: NetworkTypes.trc20,
            btc: NetworkTypes.btc,
            ltc: NetworkTypes.ltc,
            doge: NetworkTypes.doge,
            dash: NetworkTypes.dash,
            bch: NetworkTypes.bch,
            ripple: NetworkTypes.ripple,
            stellar: NetworkTypes.stellar,
            cardano: NetworkTypes.cardano,
            solana: NetworkTypes.solana,
            ton: NetworkTypes.ton,
        };
        const resolved = familyToNetwork[family];
        this.logger.log(
            `Auto-detected network from address | userId: ${userId} | family: ${family} | resolvedNetwork: ${resolved}`
        );
        return resolved;
    }

    /**
     * Verify a wallet address with the provider, falling back to local regex validation
     * if the provider rejects a locally-valid address format.
     */
    private async validateWalletAddress(
        userId: number,
        address: string,
        currency: string,
        network: NetworkTypes | undefined,
    ): Promise<void> {
        const addressFamily = this.inferAddressFamily(address);

        try {
            const verification = await this.walletAddressService.verifyWalletAddress({
                currency: currency.toLowerCase() as any,
                address,
                network,
            });

            if (!verification?.data?.valid) {
                if (addressFamily !== "unknown") {
                    this.logger.warn(
                        `Quidax rejected address but local validation passed — proceeding | userId: ${userId} | currency: ${currency} | network: ${network} | family: ${addressFamily} | address: ${address.slice(0, 10)}...`
                    );
                    return;
                }
                this.logger.warn(
                    `Address validation returned invalid | userId: ${userId} | currency: ${currency} | network: ${network} | address: ${address.slice(0, 10)}...`
                );
                throw new IncompleteAccountSetupException(
                    "Invalid wallet address for selected currency",
                    HttpStatus.BAD_REQUEST
                );
            }
        } catch (error) {
            if (error instanceof IncompleteAccountSetupException) throw error;

            if (addressFamily !== "unknown") {
                this.logger.warn(
                    `Address verification API failed but local validation passed — proceeding | userId: ${userId} | currency: ${currency} | network: ${network} | family: ${addressFamily} | error: ${error.message}`
                );
                return;
            }
            this.logger.warn(`Address verification failed | userId: ${userId} | currency: ${currency} | network: ${network} | error: ${error.message}`);
            throw new IncompleteAccountSetupException(
                "Unable to verify wallet address. Please check the address and try again.",
                HttpStatus.BAD_REQUEST
            );
        }
    }

    private inferAddressFamily(address: string):
        | "evm"
        | "trc20"
        | "btc"
        | "ltc"
        | "doge"
        | "dash"
        | "bch"
        | "ripple"
        | "stellar"
        | "cardano"
        | "solana"
        | "ton"
        | "unknown" {
        const trimmed = address.trim();

        if (/^0x[a-fA-F0-9]{40}$/.test(trimmed)) return "evm";
        if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(trimmed)) return "trc20";
        if (/^(bc1|[13])[A-HJ-NP-Z0-9]{25,62}$/i.test(trimmed)) return "btc";
        if (/^L[1-9A-HJ-NP-Za-km-z]{26,33}$/.test(trimmed)) return "ltc";
        if (/^D[5-9A-HJ-NP-Ua-km-z]{32}$/.test(trimmed)) return "doge";
        if (/^X[1-9A-HJ-NP-Za-km-z]{33}$/.test(trimmed)) return "dash";
        if (/^(bitcoincash:)?[qp][a-z0-9]{41}$/i.test(trimmed)) return "bch";
        if (/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(trimmed)) return "ripple";
        if (/^G[A-Z2-7]{55}$/.test(trimmed)) return "stellar";
        if (/^addr1[0-9a-z]{20,}$/i.test(trimmed)) return "cardano";
        if (/^(EQ|UQ)[A-Za-z0-9_-]{46,64}$/.test(trimmed)) return "ton";
        if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) return "solana";

        return "unknown";
    }

    private isNetworkCompatibleWithAddress(network: string | undefined, address: string): boolean {
        if (!network) {
            return true;
        }

        const normalizedNetwork = this.tradeHelpers.normalizeNetworkInput(network);
        if (!normalizedNetwork) {
            return true;
        }

        const family = this.inferAddressFamily(address);
        if (family === "unknown") {
            return true;
        }

        if (family === "evm") {
            return this.evmNetworks.has(normalizedNetwork);
        }

        const familyNetworkMap: Record<Exclude<typeof family, "evm" | "unknown">, NetworkTypes> = {
            trc20: NetworkTypes.trc20,
            btc: NetworkTypes.btc,
            ltc: NetworkTypes.ltc,
            doge: NetworkTypes.doge,
            dash: NetworkTypes.dash,
            bch: NetworkTypes.bch,
            ripple: NetworkTypes.ripple,
            stellar: NetworkTypes.stellar,
            cardano: NetworkTypes.cardano,
            solana: NetworkTypes.solana,
            ton: NetworkTypes.ton,
        };

        return familyNetworkMap[family] === normalizedNetwork;
    }

    /**
     * Gets the crypto withdrawal fee including network and admin fees
     */
    async getCryptoWithdrawerFee(dto: GetCryptoWithdrawerFeeDto) {
        const currency = dto.currency.toUpperCase();

        // Fetch only provider fee (admin fee is removed)
        const providerFeeInfo = await this.quidaxService.getWithdrawerFees({
            currency: dto.currency.toLowerCase(),
            ...(dto.network && { network: dto.network }),
        });

        // Calculate provider fee
        const providerFee = await this.getFee(dto.amount, providerFeeInfo.data);

        // Admin fee is removed per business plan
        const adminFeeAmount = 0;

        // Calculate total fee (provider fee only)
        const totalFee = providerFee.fee;

        return buildResponse({
            message: "withdrawer fee info retrieved",
            data: {
                networkFee: providerFee.fee,
                adminFee: adminFeeAmount,
                totalFee: totalFee,
                feeType: providerFee.type,
                currency: currency,
            },
        });
    }

    /**
     * Creates a withdrawal/send request
     * 
     * VIRTUAL BALANCE FLOW:
     * 1. Check rate limits
     * 2. Check for pending sweeps (block if user's deposits not yet confirmed)
     * 3. HOLD amount on user's ledger
     * 4. Check main wallet liquidity
     * 5. If liquidity available: execute withdrawal from main wallet
     * 6. If insufficient: add to queue (shows as pending to user)
     */
    async withdrawerRequest(user: User, dto: WithdrawerRequestDto) {
        return this.distributedLockService.withLock(
            `trade:withdraw:${user.id}`,
            async () => {
        this.logger.log(
            `withdrawerRequest called | userId: ${user.id}, currency: ${dto.currency}, amount: ${dto.amount}, recipient: ${dto.recipientWalletAddress?.slice(0, 10)}...`
        );

        // Handle Internal Transfer
        if (dto.isInternal === true) {
            return this.processInternalTransfer(user, dto);
        }

        const currency = dto.currency.toUpperCase();
        const recipientWalletAddress = dto.recipientWalletAddress?.trim();

        if (!recipientWalletAddress) {
            throw new IncompleteAccountSetupException(
                "Recipient wallet address is required",
                HttpStatus.BAD_REQUEST
            );
        }

        // Block self-sends: prevent user from sending to their own deposit address.
        // This avoids a wasted withdrawal fee (funds leave via on-chain withdrawal
        // and immediately return as a new deposit on the same sub-account).
        await this.assertNotOwnDepositAddress(user.id, recipientWalletAddress, currency);

        // Auto-detect network from address format when not provided by the client.
        const resolvedNetwork = this.resolveNetwork(user.id, dto.network, recipientWalletAddress);

        this.logger.debug(
            `Withdrawal validation | userId: ${user.id} | currency: ${currency} | dto.network: ${dto.network} | resolvedNetwork: ${resolvedNetwork} | address: ${recipientWalletAddress.slice(0, 10)}...`
        );

        if (!this.isNetworkCompatibleWithAddress(resolvedNetwork, recipientWalletAddress)) {
            throw new IncompleteAccountSetupException(
                "Wallet address is not compatible with the selected network",
                HttpStatus.BAD_REQUEST
            );
        }

        // Verify address with provider, falling back to local regex validation.
        await this.validateWalletAddress(user.id, recipientWalletAddress, currency, resolvedNetwork);

        // Check rate limits FIRST (cheap local check before any external API calls)
        const rateLimitCheck = await this.checkWithdrawalRateLimits(user.id, currency);
        if (!rateLimitCheck.allowed) {
            this.logger.warn(
                `Withdrawal blocked by rate limit | userId: ${user.id} | currency: ${currency} | reason: ${rateLimitCheck.reason}`
            );
            throw new RateLimitExceededException(rateLimitCheck.reason);
        }

        // 1. Calculate Fees (External Only)
        // We must fetch the authoritative fee from the provider/admin settings
        // to ensure the user has enough balance for Amount + Fee.
        const feeDataRes = await this.fetchWithdrawalFee(user.id, dto.amount, currency, resolvedNetwork);

        const networkFee = new Decimal(feeDataRes.data.totalFee || 0);
        const amount = new Decimal(dto.amount);
        const totalAmount = amount.plus(networkFee); // Total = Amount + Fee

        // Check for pending sweeps - user can't withdraw until deposits are confirmed
        // NOTE: In omnibus mode (no sub-account), this auto-resolves and returns false.
        const hasPendingSweeps = await this.sweepService.hasPendingSweeps(user.id, currency);
        if (hasPendingSweeps) {
            this.logger.warn(
                `Withdrawal blocked by pending sweep | userId: ${user.id}, currency: ${currency}`
            );
            throw new IncompleteAccountSetupException(
                "Please wait for your recent deposit to be confirmed before withdrawing. This usually takes a few minutes.",
                HttpStatus.BAD_REQUEST
            );
        }

        // Get user's available balance from ledger
        // We don't check totalAmount here because we do strict check inside the lock below.
        // But a quick check fails fast.
        const balance = await this.ledgerService.getBalance(user.id, currency);
        if (balance.available.lessThan(totalAmount)) {
            throw new IncompleteAccountSetupException(
                `Insufficient balance. Available: ${balance.available.toString()} ${currency} (Required: ${totalAmount.toString()} ${currency})`,
                HttpStatus.BAD_REQUEST
            );
        }

        const reference = generateId({ type: "reference" });
        const transactionId = generateId({ type: "transaction" });

        // Pre-hold validation: Real-time monitoring for high-value transactions
        // This runs BEFORE the lock to avoid holding the lock during external calls.
        // The hold() method acquires its own lock internally for balance operations.
        const monitorResult = await this.transactionMonitor.validateBeforeExecution({
            userId: user.id,
            currency,
            amount: totalAmount.toNumber(),
            operationType: "WITHDRAWAL",
            reference: `withdrawal:${reference}`,
        });

        if (!monitorResult.success) {
            this.logger.warn(
                `Transaction monitor blocked withdrawal | User: ${user.id} | Amount: ${totalAmount} ${currency} | Reason: ${monitorResult.reason}`
            );
            throw new GeneralTransactionException(
                monitorResult.reason || "Transaction blocked by monitoring system",
                HttpStatus.FORBIDDEN
            );
        }

        // HOLD the TOTAL amount on user's ledger
        // hold() acquires its own distributed lock on ledger:{userId}:{currency}
        const holdResult = await this.ledgerService.hold({
            userId: user.id,
            currency: currency,
            amount: totalAmount,
            reference: `withdrawal:${reference}`,
            type: LedgerType.WITHDRAWAL,
            description: `Withdrawal to ${dto.recipientWalletAddress} (Fee: ${networkFee})`,
            metadata: {
                destinationAddress: dto.recipientWalletAddress,
                destinationTag: dto.destinationTag,
                network: resolvedNetwork,
                narration: dto.narration,
                transaction_note: dto.transaction_note,
            },
        });

        if (!holdResult.success) {
            this.logger.error(`Failed to hold balance for withdrawal | ${JSON.stringify({
                userId: user.id,
                currency,
                amount: totalAmount,
                error: holdResult.error,
            })}`);
            throw new IncompleteAccountSetupException(
                holdResult.error || "Failed to process withdrawal",
                HttpStatus.BAD_REQUEST
            );
        }

        // Check main wallet liquidity (Check against clean amount sent or total? Usually total if we pay fee from same wallet)
        const mainWalletBalance = await this.getMainWalletBalance(currency);
        // We only send 'dto.amount' to the user, but we might pay 'networkFee' from the wallet too.
        // Safest to check we have totalAmount.
        const hasLiquidity = mainWalletBalance.greaterThanOrEqualTo(totalAmount);

        // Get fiat equivalent for record (using base amount for value tracking usually, but let's track total value out)
        const amtFiat = await this.getAmountInNaira(currency, dto.amount);

        // Create order record (will be updated with provider ID once executed)
        const createdOrder = await this.prisma.order.create({
            data: {
                orderCategory: OrderCategory.SEND,
                status: hasLiquidity ? OrderStatus.processing : OrderStatus.pending,
                streamlinedStatus: getStreamlinedStatus(hasLiquidity ? OrderStatus.processing : OrderStatus.pending),
                orderReference: reference,
                transactionId: transactionId,
                userId: user.id,
                currency: currency,
                narration: dto.narration,
                transaction_note: dto.transaction_note,
                recipient: dto.recipientWalletAddress,
                destinationTag: dto.destinationTag,
                amount: dto.amount, // The amount receiving
                fee: networkFee.toNumber(), // The fee paid
                total: totalAmount.toNumber(), // The total deducted
                amountInFiat: amtFiat?.amount,
                rateAtConversion: amtFiat?.rate,
                sender: user.email,
                sourceType: resolvedNetwork || currency,
                ledgerEntryId: holdResult.entryId,
                network: dto.network ?? undefined,
            },
        });

        // Emit transaction update immediately
        this.wsGateway.notifyTransactionUpdate(user.id, {
            type: "transaction_update",
            transaction: {
                id: createdOrder.id,
                transactionId: createdOrder.transactionId,
                status: createdOrder.status,
                streamlinedStatus: createdOrder.streamlinedStatus,
                orderCategory: createdOrder.orderCategory,
                amount: createdOrder.amount,
                currency: createdOrder.currency,
                createdAt: createdOrder.createdAt,
                updatedAt: createdOrder.updatedAt,
            },
        });

        if (hasLiquidity) {
            // Execute withdrawal from main wallet immediately
            return await this.executeWithdrawalFromMainWallet(user, createdOrder, dto, holdResult.entryId, resolvedNetwork);
        } else {
            // Add to queue - withdrawal will be processed when liquidity is available
            const queueResult = await this.withdrawalQueueService.addToQueue({
                holdEntryId: holdResult.entryId,
                userId: user.id,
                currency: currency,
                amount: totalAmount,
                reason: QueueReason.LOW_LIQUIDITY,
            });

            if (!queueResult.success) {
                // Release hold if queueing fails
                await this.ledgerService.releaseHold(
                    `withdrawal:${reference}`,
                    false,
                    "Failed to queue withdrawal"
                );
                throw new IncompleteAccountSetupException(
                    "Failed to process withdrawal. Please try again.",
                    HttpStatus.INTERNAL_SERVER_ERROR
                );
            }

            // Notify admin about liquidity issue
            await this.slackWebhookService.sendAlert(
                "LOW_LIQUIDITY_QUEUE",
                {
                    text: `⚠️ Withdrawal queued due to low liquidity\n` +
                        `User: ${user.id} (${user.email})\n` +
                        `Amount: ${totalAmount} ${currency}\n` +
                        `Queue Position: ${queueResult.queueEntry?.position}\n` +
                        `Main Wallet Balance: ${mainWalletBalance.toString()} ${currency}`,
                },
                { alertKey: `queue:${reference}` }
            );

            // WebSocket: Notify user their withdrawal is queued
            this.wsGateway.notifyWithdrawalQueued(user.id, {
                queueId: queueResult.queueEntry?.id,
                currency,
                amount: totalAmount.toString(),
                position: queueResult.queueEntry?.position,
                reason: "LOW_LIQUIDITY",
            });

            // Send queued notification (in-app + push)
            await this.notificationDispatcher.notify({
                userId: user.id,
                title: "Send transaction queued",
                body: `\u23F3 Your send of ${dto.amount} ${currency.toUpperCase()} is being processed. This may take a few minutes. Transaction ID: ${transactionId}.`,
                category: "transaction",
                currency: currency,
                transactionType: OrderCategory.SEND,
                enablePush: true,
            });

            // Emit wallet update
            this.wsGateway.notifyWalletUpdate(user.id);

            return buildResponse({
                message: "Withdrawal request received and is being processed",
                data: {
                    transactionId: createdOrder.transactionId,
                    status: "queued",
                    statusHint: "Your withdrawal is being processed. This may take a few minutes.",
                    queuePosition: queueResult.queueEntry?.position,
                    // Include order details for frontend rendering
                    amount: String(createdOrder.amount),
                    currency: createdOrder.currency,
                    fee: String(createdOrder.fee),
                    total: String(createdOrder.total),
                    recipient: {
                        details: {
                            address: createdOrder.recipient || dto.recipientWalletAddress || "",
                            destination_tag: dto.destinationTag || "",
                            name: null,
                        },
                        type: "coin_address",
                    },
                    created_at: createdOrder.createdAt?.toISOString() || new Date().toISOString(),
                },
            });
        }
            },
            { ttlMs: 30000, maxWaitMs: 5000, strict: true },
        );
    }

    /**
     * Gets main wallet balance for a currency
     */
    private async getMainWalletBalance(currency: string): Promise<Decimal> {
        try {
            // Get balance from Quidax main account
            const wallets = await this.quidaxService.getUserWalletList({ user_id: "me" });
            const wallet = wallets.data?.find(
                (w: any) => w.currency.toUpperCase() === currency.toUpperCase()
            );
            return wallet ? new Decimal(wallet.balance || "0") : new Decimal(0);
        } catch (error) {
            this.logger.error(`Failed to get main wallet balance | ${JSON.stringify({
                currency,
                error: error.message,
            })}`);
            return new Decimal(0);
        }
    }

    /**
     * Executes withdrawal from main wallet
     */
    private async executeWithdrawalFromMainWallet(
        user: User,
        order: any,
        dto: WithdrawerRequestDto,
        holdEntryId: string,
        resolvedNetwork?: string
    ) {
        try {
            // Execute withdrawal from main wallet (not user's sub-account)
            const requestRes = await this.quidaxService.createWithdrawerRequest({
                amount: order.amount.toString(),
                currency: order.currency.toLowerCase(),
                narration: dto.narration || order.narration,
                transaction_note: dto.transaction_note || order.transaction_note,
                user_id: "me", // Main wallet
                fund_uid: dto.recipientWalletAddress,
                fund_uid2: dto.destinationTag,
                reference: order.orderReference,
                network: resolvedNetwork || dto.network,
            });

            // Update order with provider details
            await this.prisma.order.update({
                where: { id: order.id },
                data: {
                    providerOrderId: requestRes.data.id,
                    fee: +requestRes.data.fee,
                    total: +requestRes.data.total,
                    status: OrderStatus.processing,
                    streamlinedStatus: getStreamlinedStatus(OrderStatus.processing),
                },
            });

            // Emit wallet update
            this.wsGateway.notifyWalletUpdate(user.id);

            // Send notification
            const message = `Your send of ${order.amount} ${order.currency.toUpperCase()} is being processed. Transaction ID: ${order.transactionId}`;

            await this.notificationDispatcher.notify({
                userId: user.id,
                title: "Send transaction initiated",
                body: message,
                category: "transaction",
                currency: order.currency,
                transactionType: OrderCategory.SEND,
                enableEmail: true,
                emailPayload: {
                    email: user.email,
                    transactionType: 'withdrawal',
                    transactionId: order.transactionId,
                    amount: String(order.amount),
                    currency: order.currency,
                    status: 'processing',
                    date: new Date().toISOString(),
                },
                enablePush: true,
            });

            return buildResponse({
                message: "Withdrawal request placed successfully",
                data: {
                    ...requestRes.data,
                    transactionId: order.transactionId,
                },
            });
        } catch (error) {
            this.logger.error(`Failed to execute withdrawal | ${JSON.stringify({
                orderId: order.id,
                error: error.message,
            })}`);

            // Queue the withdrawal instead of failing completely
            const queueResult = await this.withdrawalQueueService.addToQueue({
                holdEntryId: holdEntryId,
                userId: user.id,
                currency: order.currency,
                amount: new Decimal(order.total), // Issue #5 fix: Use total (amount + fee), not just amount
                reason: QueueReason.LOW_LIQUIDITY,
            });

            // Update order status
            await this.prisma.order.update({
                where: { id: order.id },
                data: {
                    status: OrderStatus.pending,
                    streamlinedStatus: getStreamlinedStatus(OrderStatus.pending),
                    reason: `Queued: ${error.message}`,
                },
            });

            // WebSocket: Notify user their withdrawal is queued
            if (queueResult.success && queueResult.queueEntry) {
                this.wsGateway.notifyWithdrawalQueued(user.id, {
                    queueId: queueResult.queueEntry.id,
                    currency: order.currency,
                    amount: order.amount.toString(),
                    position: queueResult.queueEntry.position,
                    reason: "LOW_LIQUIDITY",
                });
            }

            return buildResponse({
                message: "Withdrawal request received and is being processed",
                data: {
                    transactionId: order.transactionId,
                    status: "queued",
                    statusHint: "Your withdrawal is being processed. This may take a few minutes.",
                    // Include order details for frontend rendering
                    amount: String(order.amount),
                    currency: order.currency,
                    fee: String(order.fee),
                    total: String(order.total),
                    recipient: {
                        details: {
                            address: order.recipient || dto.recipientWalletAddress || "",
                            destination_tag: dto.destinationTag || "",
                            name: null,
                        },
                        type: "coin_address",
                    },
                    created_at: order.createdAt?.toISOString() || new Date().toISOString(),
                },
            });
        }
    }



    /**
     * Cancels a pending withdrawal request
     */
    async cancelWithdrawerRequest(user: User, dto: CancelWithdrawerRequestDto) {
        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "Please complete your account setup or contact admin for support",
                HttpStatus.BAD_REQUEST
            );
        }

        const requestRes = await this.quidaxService.cancelWithdrawerRequest({
            user_id: user.cryptoSubAccountId,
            withdrawal_id: dto.withdrawal_id,
        });

        return buildResponse({
            message: "Withdrawer cancel request placed successfully",
            data: requestRes.data,
        });
    }

    /**
     * Processing for internal P2P transfers
     */
    private async processInternalTransfer(user: User, dto: WithdrawerRequestDto) {
        const currency = dto.currency.toUpperCase();
        const totalAmount = dto.amount;

        if (!dto.recipientEmail) {
            throw new IncompleteAccountSetupException(
                "Recipient email is required for internal transfers",
                HttpStatus.BAD_REQUEST
            );
        }

        // Normalize recipient email — emails are stored lowercase at registration,
        // but users may type mixed-case input causing case-sensitive lookup misses
        const recipientEmail = dto.recipientEmail.toLowerCase().trim();

        // 1. Resolve Recipient
        // Using prisma directly to avoid circular dependency if UserService is not available or to be efficient
        const recipient = await this.prisma.user.findUnique({
            where: { email: recipientEmail },
            select: { id: true, email: true, firstName: true, lastName: true },
        });

        if (!recipient) {
            throw new IncompleteAccountSetupException(
                "No account found with this email address. Please check and try again.",
                HttpStatus.BAD_REQUEST
            );
        }

        if (recipient.id === user.id) {
            throw new IncompleteAccountSetupException(
                "Cannot send funds to yourself",
                HttpStatus.BAD_REQUEST
            );
        }

        // 2. Rate limits bypassed for internal transfers
        // External withdrawals still check limits earlier in the flow

        let reference = generateId({ type: "reference" });
        const transactionId = generateId({ type: "transaction" });

        // Idempotency Check
        if (dto.idempotencyKey) {
            reference = `INT-${dto.idempotencyKey}`;
            const existingOrder = await this.prisma.order.findFirst({
                where: { orderReference: reference },
                select: {
                    transactionId: true,
                    recipient: true,
                    amount: true,
                    currency: true,
                    fee: true,
                    total: true,
                    createdAt: true,
                },
            });

            if (existingOrder) {
                return buildResponse({
                    message: "Transfer successful",
                    data: {
                        transactionId: existingOrder.transactionId,
                        status: "completed",
                        amount: String(existingOrder.amount ?? totalAmount),
                        currency: existingOrder.currency ?? currency,
                        fee: String(existingOrder.fee ?? 0),
                        total: String(existingOrder.total ?? existingOrder.amount ?? totalAmount),
                        recipient: {
                            details: {
                                address: existingOrder.recipient || recipient.email,
                                destination_tag: "",
                                name: null,
                            },
                            type: "internal",
                        },
                        created_at:
                            existingOrder.createdAt?.toISOString() ||
                            new Date().toISOString(),
                    },
                });
            }
        }

        // From this point on, the user's intent is clear — record failures in history
        try {
            // 3. Check Balance
            const balance = await this.ledgerService.getBalance(user.id, currency);
            if (balance.available.lessThan(totalAmount)) {
                throw new IncompleteAccountSetupException(
                    `Insufficient balance. Available: ${balance.available.toString()} ${currency}`,
                    HttpStatus.BAD_REQUEST
                );
            }

            // TASK-006: Wrap validation + transfer inside distributed lock scope
            // This prevents race conditions where balance changes between validation and transfer
            const transferResult = await this.ledgerService.runWithMultiUserLocks(
                [user.id, recipient.id],
                currency,
                async () => {
                    // 4. Validation (Monitor) - now inside lock scope
                    const monitorResult = await this.transactionMonitor.validateBeforeExecution({
                        userId: user.id,
                        currency,
                        amount: totalAmount,
                        operationType: "SEND", // Monitor as SEND
                        reference: `send:${reference}`,
                    });

                    if (!monitorResult.success) {
                        this.logger.warn(
                            `Transaction monitor blocked internal send | User: ${user.id} | Amount: ${totalAmount} | Reason: ${monitorResult.reason}`
                        );
                        throw new GeneralTransactionException(
                            monitorResult.reason || "Transaction blocked by monitoring system",
                            HttpStatus.FORBIDDEN
                        );
                    }

                    // 5. Execute Atomic Transfer with skipLocking since we already hold the locks
                    return await this.ledgerService.internalTransfer(
                        user.id,
                        recipient.id,
                        currency,
                        totalAmount,
                        reference,
                        dto.narration || dto.transaction_note,
                        true // skipLocking - caller already holds locks
                    );
                }
            );

            if (!transferResult.success) {
                throw new GeneralTransactionException(
                    transferResult.error || "Transfer failed",
                    HttpStatus.INTERNAL_SERVER_ERROR
                );
            }

            // 6. Create Order Record (Sender side)
            const amtFiat = await this.getAmountInNaira(currency, totalAmount);

            await this.prisma.order.create({
                data: {
                    orderCategory: OrderCategory.SEND,
                    status: OrderStatus.completed, // Done immediately
                    streamlinedStatus: "completed",
                    orderReference: reference,
                    transactionId: transactionId,
                    userId: user.id,
                    currency: currency,
                    narration: dto.narration,
                    transaction_note: dto.transaction_note,
                    recipient: recipient.email, // Store email as recipient
                    amount: totalAmount,
                    fee: 0, // No fee for internal transfers
                    sender: user.email,
                    amountInFiat: amtFiat?.amount,
                    rateAtConversion: amtFiat?.rate,
                    ledgerEntryId: transferResult.entryId,
                    fulfilled: true,
                },
            });

            // 7. Notifications
            // Notify Sender
            await this.notificationDispatcher.notify({
                userId: user.id,
                title: "Transfer Sent",
                body: `You sent ${totalAmount} ${currency} to ${recipient.email}`,
                category: "transaction",
                currency: currency,
                transactionType: OrderCategory.SEND,
                enableEmail: true,
                enablePush: true,
            });

            // 8. Create Order Record (Recipient side) - Fix for missing history
            // Recipient needs a "RECEIVE" record to see it in their history
            await this.prisma.order.create({
                data: {
                    orderCategory: OrderCategory.RECEIVE,
                    status: OrderStatus.completed,
                    streamlinedStatus: "completed",
                    orderReference: `RCV-${reference}`, // Unique reference for recipient
                    transactionId: `${transactionId}-2`, // Ensure uniqueness
                    userId: recipient.id,
                    currency: currency,
                    narration: dto.narration,
                    transaction_note: dto.transaction_note,
                    sender: user.email, // Store sender email
                    recipient: recipient.email, // Store recipient email
                    amount: totalAmount,
                    fee: 0, // No fee for internal transfers
                    amountInFiat: amtFiat?.amount,
                    rateAtConversion: amtFiat?.rate,
                    ledgerEntryId: transferResult.creditEntryId || transferResult.entryId, // Issue #3 fix: use recipient's credit entry
                    fulfilled: true,
                },
            });

            // Notify Recipient
            await this.notificationDispatcher.notify({
                userId: recipient.id,
                title: "Funds Received",
                body: `You received ${totalAmount} ${currency} from ${user.email}`,
                category: "transaction",
                currency: currency,
                transactionType: OrderCategory.RECEIVE, // Assuming RECEIVE exists or fallback
                enableEmail: true,
                enablePush: true,
            });

            // Emit Wallet Updates
            this.wsGateway.notifyWalletUpdate(user.id);
            this.wsGateway.notifyWalletUpdate(recipient.id);

            return buildResponse({
                message: "Transfer successful",
                data: {
                    transactionId,
                    status: "completed",
                    amount: String(totalAmount),
                    currency,
                    fee: "0",
                    total: String(totalAmount),
                    recipient: {
                        details: {
                            address: recipient.email,
                            destination_tag: "",
                            name: null,
                        },
                        type: "internal",
                    },
                    created_at: new Date().toISOString(),
                },
            });
        } catch (error) {
            // Record failed order so the attempt appears in user's transaction history
            try {
                await this.prisma.order.create({
                    data: {
                        orderCategory: OrderCategory.SEND,
                        status: OrderStatus.failed,
                        streamlinedStatus: "failed",
                        orderReference: reference,
                        transactionId: transactionId,
                        userId: user.id,
                        currency: currency,
                        narration: `Failed: ${error.message || "Transfer failed"}`,
                        transaction_note: dto.transaction_note,
                        recipient: recipient.email,
                        amount: totalAmount,
                        fulfilled: false,
                    },
                });
            } catch (orderError) {
                this.logger.error(
                    `Failed to record failed internal transfer order | User: ${user.id} | Ref: ${reference} | Error: ${orderError.message}`
                );
            }

            // Re-throw the original error
            throw error;
        }
    }
}
