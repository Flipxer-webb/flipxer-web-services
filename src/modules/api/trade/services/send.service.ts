import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import { buildResponse } from "@/utils/api-response-util";
import { generateId } from "@/utils";
import {
    NotificationBeneficiary,
    NotificationStatus,
    NotificationType,
    OrderCategory,
    OrderStatus,
    TransactionFeeCategory,
    User,
    UserNotificationTarget,
    NetworkTypes,
} from "@prisma/client";
import { IncompleteAccountSetupException, UnknownFeeStructureException } from "../errors";
import {
    CancelWithdrawerRequestDto,
    GetCryptoWithdrawerFeeDto,
    WithdrawerRequestDto,
} from "../dtos";
import { WsGateway } from "../gateway/v1";
import { TradeHelpersService } from "./trade-helpers.service";
import { WalletAddressService } from "./wallet-address.service";
import { getStreamlinedStatus } from "../interfaces/trade";
import { DEFAULT_TRANSACTION_TIMEOUT_MS } from "../constants";
import { WithdrawalGuardService } from "@/modules/api/risk/services/withdrawal-guard.service";

/**
 * Send Service
 * 
 * Handles all crypto send/withdrawal operations including:
 * - Creating withdrawal requests
 * - Calculating withdrawal fees
 * - Canceling pending withdrawals
 */
@Injectable()
export class SendService {
    private readonly logger = new Logger("SendService");

    constructor(
        private readonly prisma: PrismaService,
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService,
        private readonly wsGateway: WsGateway,
        private readonly tradeHelpers: TradeHelpersService,
        private readonly walletAddressService: WalletAddressService,
        private readonly withdrawalGuard: WithdrawalGuardService
    ) { }

    /**
     * Gets a fee based on amount and fee data structure
     */
    private async getFee(
        amount: number,
        data: any
    ): Promise<{ fee: number; type: string }> {
        if (data.type === "flat" && typeof data.fee === "number") {
            return {
                fee: data.fee,
                type: "flat",
            };
        }

        if (data.type === "percentage" && typeof data.fee === "number") {
            return {
                fee: (amount * data.fee) / 100,
                type: "percentage",
            };
        }

        if (data.type === "range" && Array.isArray(data.fee)) {
            for (const range of data.fee) {
                if (amount >= range.min && amount < range.max) {
                    if (range.type === "percentage") {
                        return {
                            fee: (amount * range.value) / 100,
                            type: "percentage",
                        };
                    } else {
                        return {
                            fee: range.value,
                            type: "flat",
                        };
                    }
                }
            }

            throw new IncompleteAccountSetupException(
                "Amount is out of range.",
                HttpStatus.BAD_REQUEST
            );
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
     * Gets the amount converted to Naira for sell/send orders
     */
    private async getAmountInNaira(
        currency: string,
        amount: number
    ): Promise<{ amount: number; rate: number } | null> {
        const rate = await this.prisma.cryptoRate.findUnique({
            where: { currency: currency.toUpperCase() },
        });

        if (!rate) return null;

        // Use buy rate for outgoing (what user sends out)
        return {
            amount: amount * rate.buyRate,
            rate: rate.buyRate,
        };
    }

    /**
     * Gets the crypto withdrawal fee including network and admin fees
     */
    async getCryptoWithdrawerFee(dto: GetCryptoWithdrawerFeeDto) {
        const currency = dto.currency.toUpperCase();

        // Fetch both provider fee and admin transaction fee
        const [providerFeeInfo, adminFee] = await Promise.all([
            this.quidaxService.getWithdrawerFees({
                currency: dto.currency,
                ...(dto.network && { network: dto.network }),
            }),
            this.prisma.transactionFee.findUnique({
                where: {
                    category_currency: {
                        category: TransactionFeeCategory.SELL,
                        currency,
                    },
                },
            }),
        ]);

        this.logger.debug(`Admin fee for ${currency}: ${JSON.stringify(adminFee)}`);

        // Calculate provider fee
        const providerFee = await this.getFee(dto.amount, providerFeeInfo.data);

        // Calculate admin fee (default to 0 if not configured)
        const adminFeeAmount = adminFee ? adminFee.fee : 0;

        // Calculate total fee (provider fee + admin fee)
        const totalFee = providerFee.fee + adminFeeAmount;

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
     */
    /**
     * Creates a withdrawal/send request
     */
    async withdrawerRequest(user: User, dto: WithdrawerRequestDto) {
        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "Please complete your account setup or contact admin for support",
                HttpStatus.BAD_REQUEST
            );
        }

        const currency = dto.currency.toUpperCase();

        // 0. Risk Management Check
        const riskCheck = await this.withdrawalGuard.checkWithdrawalRisk(user.id, currency, dto.amount);
        if (!riskCheck.safe) {
            throw new IncompleteAccountSetupException(
                `Withdrawal blocked by safety guard: ${riskCheck.reason}`,
                HttpStatus.BAD_REQUEST
            );
        }

        // 1. Calculate Fees (Re-fetch to ensure accuracy)
        const [feeData, adminFeeRecord] = await Promise.all([
            this.getCryptoWithdrawerFee({
                amount: dto.amount,
                currency: dto.currency,
                network: dto.network as NetworkTypes
            }),
            this.prisma.transactionFee.findUnique({
                where: {
                    category_currency: {
                        category: TransactionFeeCategory.SEND,
                        currency: currency,
                    },
                },
            }),
        ]);

        const networkFee = typeof feeData.data.networkFee === 'number' ? feeData.data.networkFee : 0;
        const paramAdminFee = typeof feeData.data.adminFee === 'number' ? feeData.data.adminFee : 0;

        // Total Amount to Deduct from User = AmountToSend + NetworkFee + AdminFee
        // Note: Quidax usually charges the fee on top or from amount. 
        // If we send 'Amount', Quidax charges 'NetworkFee' from our Master Wallet Balance.
        // So User must pay us 'Amount + NetworkFee + AdminFee'.
        const totalDeductible = dto.amount + networkFee + paramAdminFee;

        // 2. Atomic Ledger Deduction
        const reference = generateId({ type: "reference" });
        const transactionId = generateId({ type: "transaction" });

        const order = await this.prisma.$transaction(async (tx) => {
            const wallet = await tx.assetWallet.findUnique({
                where: {
                    userId_assetCurrency: {
                        userId: user.id,
                        assetCurrency: currency
                    }
                }
            });

            if (!wallet || parseFloat(wallet.balance.toString()) < totalDeductible) {
                this.logger.warn(`Insufficient funds for send. Req: ${totalDeductible}, Bal: ${wallet?.balance}`);
                throw new IncompleteAccountSetupException("Insufficient funds for transaction", HttpStatus.BAD_REQUEST);
            }

            // Deduct Total
            await tx.assetWallet.update({
                where: { id: wallet.id },
                data: {
                    balance: { decrement: totalDeductible }
                }
            });

            // Calculate Fiat Equivalent for Reporting
            const amtFiat = await this.getAmountInNaira(dto.currency, dto.amount);

            // Create Order
            return await tx.order.create({
                data: {
                    orderCategory: OrderCategory.SEND,
                    status: OrderStatus.processing,
                    streamlinedStatus: getStreamlinedStatus(OrderStatus.processing),
                    orderReference: reference,
                    transactionId: transactionId,
                    userId: user.id,
                    currency: dto.currency,
                    narration: dto.narration,
                    transaction_note: dto.transaction_note,
                    recipient: dto.recipientWalletAddress,
                    amount: dto.amount,
                    fee: networkFee + paramAdminFee,
                    total: totalDeductible,
                    destinationTag: dto.destinationTag,
                    sourceType: "wallet",
                    amountInFiat: amtFiat?.amount,
                    rateAtConversion: amtFiat?.rate,
                },
            });
        });

        // 3. Execute Internal/External Withdrawal (From Master Wallet)
        try {
            const requestRes = await this.quidaxService.createWithdrawerRequest({
                amount: dto.amount.toString(),
                currency: dto.currency,
                narration: dto.narration,
                transaction_note: dto.transaction_note,
                user_id: "me", // SOURCE IS MASTER WALLET
                fund_uid: dto.recipientWalletAddress,
                fund_uid2: dto.destinationTag,
                reference: reference, // Link reference
                network: dto.network as NetworkTypes,
            });

            // 4. Update Order with Provider ID
            await this.prisma.order.update({
                where: { id: order.id },
                data: {
                    providerOrderId: requestRes.data.id,
                    status: OrderStatus.processing, // Still processing until webhook confirms? 
                    // Actually Quidax returns "pending" or "success".
                    // If immediate success (unlikely for crypto), update.
                    // Usually it's pending.
                }
            });

            // 5. Notifications
            this.wsGateway.notifyTransactionUpdate(user.id, {
                type: "transaction_update",
                transaction: { ...order, providerOrderId: requestRes.data.id }
            });
            this.wsGateway.notifyWalletUpdate(user.id);

            const message = `Your send of ${dto.amount} ${dto.currency.toUpperCase()} is being processed. Transaction ID: ${transactionId}`;
            await this.createNotification(user.id, "Send transaction initiated", message, dto.currency, OrderCategory.SEND);

            return buildResponse({
                message: "Withdrawer request placed successfully",
                data: {
                    ...requestRes.data,
                    transactionId: transactionId,
                },
            });

        } catch (error) {
            this.logger.error(`Send Request Failed: ${error.message}`, error.stack);

            // 6. Refund on Failure
            await this.prisma.$transaction(async (tx) => {
                await tx.assetWallet.update({
                    where: {
                        userId_assetCurrency: { userId: user.id, assetCurrency: currency }
                    },
                    data: { balance: { increment: totalDeductible } }
                });

                await tx.order.update({
                    where: { id: order.id },
                    data: {
                        status: OrderStatus.failed,
                        streamlinedStatus: getStreamlinedStatus(OrderStatus.failed),
                        transaction_note: `Failed: ${error.message}`
                    }
                });
            });

            this.wsGateway.notifyWalletUpdate(user.id);
            this.wsGateway.notifyTransactionUpdate(user.id, {
                type: "transaction_update",
                transaction: { ...order, status: OrderStatus.failed }
            });

            throw new IncompleteAccountSetupException(
                `Withdrawal failed: ${error.message}`,
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    private async createNotification(userId: number, title: string, body: string, currency: string, type: OrderCategory) {
        const createdNotification = await this.prisma.notification.create({
            data: {
                title,
                body,
                userId,
                target: UserNotificationTarget.SINGLE,
                beneficiary: NotificationBeneficiary.INDIVIDUAL,
                type: NotificationType.MESSAGE,
                status: NotificationStatus.APPROVED,
                senderId: null,
                transactionType: type,
                currency: currency,
            },
        });

        const notificationList = await this.prisma.notification.findMany({
            where: { userId },
            orderBy: { createdAt: "desc" },
            take: 20,
        });

        this.wsGateway.notifyUser(userId, {
            type: "new_notification",
            notification: createdNotification,
            notificationList,
        });
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
}
