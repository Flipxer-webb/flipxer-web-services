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
        private readonly walletAddressService: WalletAddressService
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
    async withdrawerRequest(user: User, dto: WithdrawerRequestDto) {
        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "Please complete your account setup or contact admin for support",
                HttpStatus.BAD_REQUEST
            );
        }

        const reference = generateId({ type: "reference" });
        const requestRes = await this.quidaxService.createWithdrawerRequest({
            amount: dto.amount.toString(),
            currency: dto.currency,
            narration: dto.narration,
            transaction_note: dto.transaction_note,
            user_id: user.cryptoSubAccountId,
            fund_uid: dto.recipientWalletAddress, //receiving wallet address
            fund_uid2: dto.destinationTag, // destination tag
            reference: reference,
            network: dto.network, // blockchain network for the transaction
        });

        const amtFiat = await this.getAmountInNaira(
            requestRes.data.currency,
            Number(requestRes.data.amount)
        );

        const createdOrder = await this.prisma.order.create({
            data: {
                orderCategory: OrderCategory.SEND,
                status: OrderStatus.processing,
                streamlinedStatus: getStreamlinedStatus(OrderStatus.processing),
                orderReference: reference,
                transactionId: generateId({ type: "transaction" }),
                providerOrderId: requestRes.data.id,
                userId: user.id,
                currency: requestRes.data.currency,
                narration: requestRes.data.narration,
                transaction_note: requestRes.data.transaction_note,
                recipient: requestRes.data.recipient.details.address,
                amount: +requestRes.data.amount,
                fee: +requestRes.data.fee,
                total: +requestRes.data.total,
                sourceType: requestRes.data.type,
                amountInFiat: amtFiat?.amount,
                rateAtConversion: amtFiat?.rate,
            },
        });

        // Emit transaction update immediately so UI shows the new transaction
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

        // Sync wallet with Quidax to ensure balance is up to date
        await this.walletAddressService.syncWallet(user.id, dto.currency);

        // Emit wallet update since balance changes immediately with send
        this.wsGateway.notifyWalletUpdate(user.id);

        // Create and send notification for processing
        const message = `Your send of ${createdOrder.amount} ${createdOrder.currency.toUpperCase()} is being processed. Transaction ID: ${createdOrder.transactionId}`;

        const createdNotification = await this.prisma.notification.create({
            data: {
                title: "Send transaction initiated",
                body: message,
                userId: user.id,
                target: UserNotificationTarget.SINGLE,
                beneficiary: NotificationBeneficiary.INDIVIDUAL,
                type: NotificationType.MESSAGE,
                status: NotificationStatus.APPROVED,
                senderId: null,
                transactionType: OrderCategory.SEND,
                currency: createdOrder.currency,
            },
        });

        const notificationList = await this.prisma.notification.findMany({
            where: { userId: user.id },
            orderBy: { createdAt: "desc" },
            take: 20,
        });

        this.wsGateway.notifyUser(user.id, {
            type: "new_notification",
            notification: createdNotification,
            notificationList,
        });

        return buildResponse({
            message: "Withdrawer request placed successfully",
            data: {
                ...requestRes.data,
                transactionId: createdOrder.transactionId,
            },
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
