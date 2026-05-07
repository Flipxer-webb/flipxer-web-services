import {
    BadRequestException,
    HttpStatus,
    Injectable,
    Logger,
} from "@nestjs/common";
import { NormalizedPaymentEvent } from "@/modules/api/banks/types/payment-event.interface";
import { PrismaService } from "@/modules/core/prisma/services";
import {
    getBankProviderForPaymentMethod,
    getPaymentMethodForBankProvider,
    InboundPaymentInitializationResult,
    InboundPaymentProvider,
} from "@/modules/factory/bank/types";
import { InboundFiatPaymentService } from "@/modules/factory/bank/services/inbound-fiat-payment.service";
import { buildResponse } from "@/utils/api-response-util";
import { generateId } from "@/utils";
import { COMPANY_NAME, buyPaymentProvider, frontendUrl } from "@/config";
import { RateService } from "./rate.service";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import {
    CryptoWalletStatus,
    LedgerType,
    OrderCategory,
    OrderStatus,
    PaymentMethod,
    SweepStatus,
    TransactionStatus,
    TransactionType,
    User,
} from "@prisma/client";
import {
    IncompleteAccountSetupException,
    WalletAddressNotFoundException,
} from "../errors";
import { BuyQuoteResponse, getStreamlinedStatus } from "../interfaces/trade";
import { BuyCryptoOrderDto, InitiateBuyOrderDto } from "../dtos";
import { WsGateway } from "../gateway/v1";
import { TradeHelpersService } from "./trade-helpers.service";
import { WalletAddressService } from "./wallet-address.service";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { LedgerService, PairedLedgerResult } from "./ledger/ledger.service";
import {
    EXTENDED_TRANSACTION_TIMEOUT_MS,
    DEFAULT_TRANSACTION_MAX_WAIT_MS,
    MIN_BUY_AMOUNT_USDT,
} from "../constants";
import { generateUssdCode } from "@/libs/nomba/ussd-codes";
import { DistributedLockService } from "@/modules/core/redisCache/services/distributed-lock.service";
import { TransactionService } from "@/modules/api/auth/services/transaction.service";
import {
    BUY_REFUND_REASON,
    BuyRefundReasonCode,
    BuyRefundOrchestratorService,
} from "./buy-refund-orchestrator.service";

type BuyWebhookPayment = {
    id: number;
    orderId: number;
    userId: number;
    totalAmount: unknown;
    reference: string;
    createdAt: Date;
    status?: TransactionStatus | null;
    paymentStatus?: TransactionStatus | null;
    receivedAmount?: unknown;
    externalReference?: string | null;
    senderBankCode?: string | null;
};

type ClosedBuyRefundPolicy = {
    reasonCode: BuyRefundReasonCode;
    narration: string;
    slackMessage: string;
    closedOrderReason:
        | "user_cancelled"
        | "payment_window_expired"
        | "invalid_payment_cap_reached";
};

type BuyAccountNameMatchResult = {
    matched: boolean;
    registeredAccountName: string | null;
    senderAccountName: string | null;
    expectedTokens: string[];
    actualTokens: string[];
    missingExpectedTokens: string[];
};

type ActiveInvalidRefundAttempt = {
    id: number;
    reasonCode: string;
    retryCount: number;
};

/**
 * Buy Order Service
 *
 * Handles all buy order operations including:
 * - Quote calculation for buy orders
 * - Order placement with payment gateway integration
 * - Fiat-to-crypto conversions
 */
@Injectable()
export class BuyOrderService {
    private readonly logger = new Logger("BuyOrderService");
    private static readonly CRYPTO_AMOUNT_TOLERANCE = 1e-8;
    private static readonly BUY_PAYMENT_WINDOW_MS = 35 * 60 * 1000;
    private static readonly MAX_ACTIVE_WRONG_AMOUNT_RESENDS = 2;
    private static readonly ACTIVE_INVALID_BUY_REFUND_REASONS = [
        BUY_REFUND_REASON.ACTIVE_WRONG_AMOUNT,
        BUY_REFUND_REASON.ACCOUNT_NAME_MISMATCH,
    ] as const;
    private static readonly CLOSED_BUY_REFUND_REASONS = [
        BUY_REFUND_REASON.CLOSED_INVALID_PAYMENT,
        BUY_REFUND_REASON.CANCELLED_ORDER_PAYMENT,
        BUY_REFUND_REASON.EXPIRED_LATE_PAYMENT,
    ] as const;
    private static readonly USER_CANCEL_REASON =
        "Buy order cancelled by user before payment was received.";
    private static readonly EXPIRED_CANCEL_REASON =
        "Buy order cancelled because the payment window expired.";

    constructor(
        private readonly prisma: PrismaService,
        private readonly inboundFiatPaymentService: InboundFiatPaymentService,
        private readonly wsGateway: WsGateway,
        private readonly tradeHelpers: TradeHelpersService,
        private readonly walletAddressService: WalletAddressService,
        private readonly slackWebhookService: SlackWebhookService,
        private readonly ledgerService: LedgerService,
        private readonly rateService: RateService,
        private readonly notificationDispatcher: NotificationDispatcher,
        private readonly distributedLockService: DistributedLockService,
        private readonly transactionService: TransactionService,
        private readonly buyRefundOrchestratorService: BuyRefundOrchestratorService,
    ) {}

    private async releaseReservedBuyLimit(payment: {
        userId: number;
        createdAt: Date;
        order?: {
            orderCategory?: OrderCategory;
            currency?: string | null;
            amount?: number | null;
        } | null;
    }): Promise<void> {
        if (!payment.order?.currency || !payment.order?.amount) {
            return;
        }

        await this.releaseReservedBuyRequestLimit({
            userId: payment.userId,
            currency: payment.order.currency,
            amount: Number(payment.order.amount),
            createdAt: payment.createdAt,
        });
    }

    private async releaseReservedBuyRequestLimit(options: {
        userId: number;
        currency: string | null;
        amount: number | null;
        createdAt: Date | null;
    }): Promise<void> {
        await this.transactionService.releaseDailyLimitReservationForOrder({
            userId: options.userId,
            orderCategory: OrderCategory.BUY,
            currency: options.currency,
            amount: options.amount,
            createdAt: options.createdAt,
        });
    }

    private getSupportedBuyPaymentMethods(): PaymentMethod[] {
        return [PaymentMethod.NOMBA, PaymentMethod.FINCRA];
    }

    getAvailableBuyPaymentMethods(): PaymentMethod[] {
        return [...this.getSupportedBuyPaymentMethods()];
    }

    private resolveBuyPaymentMethod(
        paymentMethod?: PaymentMethod | null,
    ): PaymentMethod {
        if (!paymentMethod) {
            return getPaymentMethodForBankProvider(buyPaymentProvider);
        }

        if (!this.getSupportedBuyPaymentMethods().includes(paymentMethod)) {
            throw new BadRequestException(
                "Unsupported buy payment method selected",
            );
        }

        return paymentMethod;
    }

    private getBuyPaymentProvider(
        paymentMethod?: PaymentMethod | null,
    ): InboundPaymentProvider {
        return (
            getBankProviderForPaymentMethod(
                this.resolveBuyPaymentMethod(paymentMethod),
            ) || buyPaymentProvider
        );
    }

    private getBuyPaymentProviderLabel(
        paymentMethod?: PaymentMethod | null,
    ): string {
        return this.getBuyPaymentProvider(paymentMethod) === "fincra"
            ? "Fincra"
            : "Nomba";
    }

    private buildManualRefundAlertAmount(payment: {
        receivedAmount?: unknown;
        totalAmount?: unknown;
    }): number {
        const receivedAmount = Number(payment.receivedAmount);
        if (Number.isFinite(receivedAmount) && receivedAmount > 0) {
            return receivedAmount;
        }

        return Number(payment.totalAmount);
    }

    private isPositiveFiatAmount(value: unknown): value is number {
        return typeof value === "number" && Number.isFinite(value) && value > 0;
    }

    private numbersMatchWithinKobo(left: number, right: number): boolean {
        return Math.abs(left - right) < 0.005;
    }

    private isExactBuyPaymentAmount(
        amount: unknown,
        expectedAmount: number,
    ): amount is number {
        return (
            this.isPositiveFiatAmount(amount) &&
            expectedAmount > 0 &&
            this.numbersMatchWithinKobo(amount, expectedAmount)
        );
    }

    private isWrongBuyPaymentAmount(
        amount: unknown,
        expectedAmount: number,
    ): amount is number {
        return (
            this.isPositiveFiatAmount(amount) &&
            expectedAmount > 0 &&
            !this.isExactBuyPaymentAmount(amount, expectedAmount)
        );
    }

    private isBuyPaymentExpired(createdAt: Date): boolean {
        return Date.now() - createdAt.getTime() >= BuyOrderService.BUY_PAYMENT_WINDOW_MS;
    }

    private isDuplicateRefundWebhook(
        payment: BuyWebhookPayment,
        event: NormalizedPaymentEvent,
    ): boolean {
        if (payment.paymentStatus !== TransactionStatus.REVERSAL) {
            return false;
        }

        if (!this.isPositiveFiatAmount(event.amount)) {
            return false;
        }

        const existingReceived = Number(payment.receivedAmount);
        const sameAmount =
            Number.isFinite(existingReceived) &&
            this.numbersMatchWithinKobo(existingReceived, event.amount);

        return (
            sameAmount &&
            payment.externalReference === (event.providerReference ?? null)
        );
    }

    private buildWebhookPaymentUpdateData(event: NormalizedPaymentEvent) {
        const paymentUpdateData: Record<string, unknown> = {};

        if (this.isPositiveFiatAmount(event.amount)) {
            paymentUpdateData.receivedAmount = event.amount;
        }
        if (event.senderAccountNumber) {
            paymentUpdateData.senderAccountNumber = event.senderAccountNumber;
        }
        if (event.senderAccountName) {
            paymentUpdateData.senderAccountName = event.senderAccountName;
        }
        if (event.senderBankName) {

            paymentUpdateData.senderBankName = event.senderBankName;
        }
        if (event.senderBankCode) {
            paymentUpdateData.senderBankCode = event.senderBankCode;
        }
        if (event.providerReference) {
            paymentUpdateData.externalReference = event.providerReference;
        }

        return paymentUpdateData;
    }

    private buildWrongAmountRefundNarration(
        receivedAmount: number,
        expectedAmount: number,
    ): string {
        const variance = receivedAmount < expectedAmount ? "below" : "above";

        return (
            `Incorrect payment amount: received ₦${receivedAmount} ${variance} ` +
            `the required ₦${expectedAmount}. Refund initiated; order remains open until expiry.`
        );
    }

    private buildLatePaymentRefundNarration(
        receivedAmount: number,
        expectedAmount: number,
    ): string {
        return (
            `Late payment received after order expiry: received ₦${receivedAmount} ` +
            `for expected ₦${expectedAmount}. Refund initiated and order closed.`
        );
    }

    private buildCancelledOrderPaymentRefundNarration(
        receivedAmount: number,
        expectedAmount: number,
    ): string {
        return (
            `Payment received after order cancellation: received ₦${receivedAmount} ` +
            `for expected ₦${expectedAmount}. Refund initiated and order remains closed.`
        );
    }

    private buildClosedInvalidPaymentRefundNarration(
        receivedAmount: number,
        expectedAmount: number,
    ): string {
        return (
            `Payment received after invalid-payment cap closure: received ₦${receivedAmount} ` +
            `for expected ₦${expectedAmount}. Refund initiated and order remains closed.`
        );
    }

    private buildActiveAccountNameMismatchRefundNarration(
        receivedAmount: number,
        expectedAmount: number,
        senderAccountName: string | null,
        registeredAccountName: string | null,
    ): string {
        const senderDescriptor = senderAccountName
            ? `from ${senderAccountName}`
            : "from an unverified sender account";
        const registeredDescriptor = registeredAccountName
            ? `the registered account holder name ${registeredAccountName}`
            : "the registered account holder name on this order";

        return (
            `Account-name validation failed: payment of ₦${receivedAmount} for expected ₦${expectedAmount} ` +
            `was received ${senderDescriptor} and did not sufficiently match ${registeredDescriptor}. ` +
            `Refund initiated; order remains open until expiry.`
        );
    }

    private buildAccountNameMismatchRetryCapNarration(
        receivedAmount: number,
        expectedAmount: number,
        senderAccountName: string | null,
        registeredAccountName: string | null,
    ): string {
        const senderDescriptor = senderAccountName
            ? `from ${senderAccountName}`
            : "from an unverified sender account";
        const registeredDescriptor = registeredAccountName
            ? `the registered account holder name ${registeredAccountName}`
            : "the registered account holder name on this order";

        return (
            `Account-name mismatch resend cap reached: payment of ₦${receivedAmount} for expected ₦${expectedAmount} ` +
            `was received ${senderDescriptor} and did not sufficiently match ${registeredDescriptor}. ` +
            `Refund initiated and order closed.`
        );
    }

    private buildExpiredAccountNameMismatchNarration(
        receivedAmount: number,
        expectedAmount: number,
        senderAccountName: string | null,
        registeredAccountName: string | null,
    ): string {
        const senderDescriptor = senderAccountName
            ? `from ${senderAccountName}`
            : "from an unverified sender account";
        const registeredDescriptor = registeredAccountName
            ? `the registered account holder name ${registeredAccountName}`
            : "the registered account holder name on this order";

        return (
            `Buy order expired after account-name mismatch: payment of ₦${receivedAmount} for expected ₦${expectedAmount} ` +
            `was received ${senderDescriptor} and did not sufficiently match ${registeredDescriptor}. ` +
            `Refund initiated and order closed.`
        );
    }

    private buildWrongAmountRetryCapNarration(
        receivedAmount: number,
        expectedAmount: number,
    ): string {
        return (
            `Wrong-amount resend cap reached: received ₦${receivedAmount} ` +
            `for expected ₦${expectedAmount}. Refund initiated and order closed.`
        );
    }

    private normalizeAccountNameTokens(name: string | null | undefined): string[] {
        if (!name) {
            return [];
        }

        const normalized = name
            .normalize("NFD")
            .replaceAll(/[\u0300-\u036f]/g, "")
            .replaceAll(/[^A-Za-z0-9\s]/g, " ")
            .toUpperCase();

        return Array.from(
            new Set(
                normalized
                    .split(/\s+/)
                    .map((token) => token.trim())
                    .filter(Boolean),
            ),
        );
    }

    private buildRegisteredBuyAccountName(
        user:
            | Pick<
                  User,
                  | "firstName"
                  | "lastName"
                  | "middleName"
                  | "businessName"
                  | "userType"
              >
            | null
            | undefined,
    ): string | null {
        if (!user) {
            return null;
        }

        if (
            String(user.userType).toUpperCase() === "BUSINESS"
            && user.businessName?.trim()
        ) {
            return user.businessName.trim();
        }

        const personalName = [user.firstName, user.lastName]
            .filter((value): value is string => Boolean(value?.trim()))
            .join(" ")
            .trim();

        if (personalName) {
            return personalName;
        }

        if (user.businessName?.trim()) {
            return user.businessName.trim();
        }

        return user.middleName?.trim() || null;
    }

    private computeLevenshteinDistance(left: string, right: string): number {
        if (left === right) {
            return 0;
        }

        if (left.length === 0) {
            return right.length;
        }

        if (right.length === 0) {
            return left.length;
        }

        const previousRow = Array.from(
            { length: right.length + 1 },
            (_, index) => index,
        );

        for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
            let previousDiagonal = previousRow[0];
            previousRow[0] = leftIndex + 1;

            for (
                let rightIndex = 0;
                rightIndex < right.length;
                rightIndex += 1
            ) {
                const current = previousRow[rightIndex + 1];
                const substitutionCost =
                    left[leftIndex] === right[rightIndex] ? 0 : 1;

                previousRow[rightIndex + 1] = Math.min(
                    previousRow[rightIndex + 1] + 1,
                    previousRow[rightIndex] + 1,
                    previousDiagonal + substitutionCost,
                );

                previousDiagonal = current;
            }
        }

        return previousRow[right.length];
    }

    private tokensLooselyMatch(expectedToken: string, actualToken: string): boolean {
        if (expectedToken === actualToken) {
            return true;
        }

        if (expectedToken.length < 5 || actualToken.length < 5) {
            return false;
        }

        return this.computeLevenshteinDistance(expectedToken, actualToken) <= 1;
    }

    private evaluateBuyPaymentAccountNameMatch(options: {
        user:
            | Pick<
                  User,
                  | "firstName"
                  | "lastName"
                  | "middleName"
                  | "businessName"
                  | "userType"
              >
            | null
            | undefined;
        senderAccountName?: string | null;
    }): BuyAccountNameMatchResult {
        const registeredAccountName = this.buildRegisteredBuyAccountName(
            options.user,
        );
        const senderAccountName = options.senderAccountName?.trim() || null;
        const expectedTokens = this.normalizeAccountNameTokens(
            registeredAccountName,
        );
        const actualTokens = this.normalizeAccountNameTokens(senderAccountName);
        const missingExpectedTokens = expectedTokens.filter(
            (expectedToken) =>
                !actualTokens.some((actualToken) =>
                    this.tokensLooselyMatch(expectedToken, actualToken),
                ),
        );

        return {
            matched:
                expectedTokens.length > 0
                && actualTokens.length > 0
                && missingExpectedTokens.length === 0,
            registeredAccountName,
            senderAccountName,
            expectedTokens,
            actualTokens,
            missingExpectedTokens,
        };
    }

    private wasBuyOrderCancelledByUser(
        payment: BuyWebhookPayment,
        order?: { status?: OrderStatus | null; reason?: string | null } | null,
    ): boolean {
        if (!order) {
            return false;
        }

        if (order.reason === BuyOrderService.USER_CANCEL_REASON) {
            return true;
        }

        if (order.reason === BuyOrderService.EXPIRED_CANCEL_REASON) {
            return false;
        }

        return (
            order.status === OrderStatus.cancelled
            && payment.status === TransactionStatus.FAILED
            && !this.isBuyPaymentExpired(payment.createdAt)
        );
    }

    private wasBuyOrderClosedByInvalidPaymentCap(
        order?: { status?: OrderStatus | null; reason?: string | null } | null,
    ): boolean {
        if (!order) {
            return false;
        }

        return (
            order.status === OrderStatus.reversed
            && Boolean(order.reason?.includes("resend cap reached"))
        );
    }

    private isClosedBuyRefundReason(
        reasonCode: string,
    ): reasonCode is (typeof BuyOrderService.CLOSED_BUY_REFUND_REASONS)[number] {
        return (BuyOrderService.CLOSED_BUY_REFUND_REASONS as readonly string[]).includes(
            reasonCode,
        );
    }

    private getOriginalClosedBuyRefundReason(
        refundAttempts:
            | Array<{
                  reasonCode: string;
              }>
            | null
            | undefined,
    ): (typeof BuyOrderService.CLOSED_BUY_REFUND_REASONS)[number] | null {
        for (let index = (refundAttempts?.length || 0) - 1; index >= 0; index -= 1) {
            const attempt = refundAttempts?.[index];

            if (attempt && this.isClosedBuyRefundReason(attempt.reasonCode)) {
                return attempt.reasonCode;
            }
        }

        return null;
    }

    private resolveClosedBuyRefundPolicy(options: {
        payment: BuyWebhookPayment;
        order?: { status?: OrderStatus | null; reason?: string | null } | null;
        refundAttempts?: Array<{
            reasonCode: string;
        }> | null;
        expectedAmount: number;
        receivedAmount: number;
    }): ClosedBuyRefundPolicy {
        const originalClosedReasonCode = this.getOriginalClosedBuyRefundReason(
            options.refundAttempts,
        );

        if (originalClosedReasonCode === BUY_REFUND_REASON.CANCELLED_ORDER_PAYMENT) {
            return {
                reasonCode: BUY_REFUND_REASON.CANCELLED_ORDER_PAYMENT,
                narration: this.buildCancelledOrderPaymentRefundNarration(
                    options.receivedAmount,
                    options.expectedAmount,
                ),
                slackMessage:
                    "Payment received after a user-cancelled BUY order. Order remains closed and refund initiated.",
                closedOrderReason: "user_cancelled",
            };
        }

        if (originalClosedReasonCode === BUY_REFUND_REASON.CLOSED_INVALID_PAYMENT) {
            return {
                reasonCode: BUY_REFUND_REASON.CLOSED_INVALID_PAYMENT,
                narration: this.buildClosedInvalidPaymentRefundNarration(
                    options.receivedAmount,
                    options.expectedAmount,
                ),
                slackMessage:
                    "Payment received after a BUY order was already closed by the invalid-payment resend cap. Order remains closed and refund initiated.",
                closedOrderReason: "invalid_payment_cap_reached",
            };
        }

        if (originalClosedReasonCode === BUY_REFUND_REASON.EXPIRED_LATE_PAYMENT) {
            return {
                reasonCode: BUY_REFUND_REASON.EXPIRED_LATE_PAYMENT,
                narration: this.buildLatePaymentRefundNarration(
                    options.receivedAmount,
                    options.expectedAmount,
                ),
                slackMessage:
                    "Late buy payment received after order expiry. Order closed as refunded.",
                closedOrderReason: "payment_window_expired",
            };
        }

        if (this.wasBuyOrderCancelledByUser(options.payment, options.order)) {
            return {
                reasonCode: BUY_REFUND_REASON.CANCELLED_ORDER_PAYMENT,
                narration: this.buildCancelledOrderPaymentRefundNarration(
                    options.receivedAmount,
                    options.expectedAmount,
                ),
                slackMessage:
                    "Payment received after a user-cancelled BUY order. Order remains closed and refund initiated.",
                closedOrderReason: "user_cancelled",
            };
        }

        if (this.wasBuyOrderClosedByInvalidPaymentCap(options.order)) {
            return {
                reasonCode: BUY_REFUND_REASON.CLOSED_INVALID_PAYMENT,
                narration: this.buildClosedInvalidPaymentRefundNarration(
                    options.receivedAmount,
                    options.expectedAmount,
                ),
                slackMessage:
                    "Payment received after a BUY order was already closed by the invalid-payment resend cap. Order remains closed and refund initiated.",
                closedOrderReason: "invalid_payment_cap_reached",
            };
        }

        return {
            reasonCode: BUY_REFUND_REASON.EXPIRED_LATE_PAYMENT,
            narration: this.buildLatePaymentRefundNarration(
                options.receivedAmount,
                options.expectedAmount,
            ),
            slackMessage:
                "Late buy payment received after order expiry. Order closed as refunded.",
            closedOrderReason: "payment_window_expired",
        };
    }

    private async getBuyPaymentWithContext(
        reference: string,
    ) {
        return this.prisma.payment.findUnique({
            where: { reference },
            include: {
                order: true,
                user: {
                    select: {
                        id: true,
                        email: true,
                        firstName: true,
                        lastName: true,
                        middleName: true,
                        businessName: true,
                        userType: true,
                    },
                },
                refundAttempts: {
                    where: {
                        reasonCode: {
                            in: [
                                ...BuyOrderService.ACTIVE_INVALID_BUY_REFUND_REASONS,
                                        ...BuyOrderService.CLOSED_BUY_REFUND_REASONS,
                            ],
                        },
                    },
                    orderBy: { createdAt: "desc" },
                },
            },
        });
    }

    private getLatestActiveInvalidRefundAttempts(
        refundAttempts?: Array<{
            id: number;
            reasonCode: string;
            retryCount?: number | null;
        }> | null,
    ): ActiveInvalidRefundAttempt[] {
        const latestByReason = new Map<string, ActiveInvalidRefundAttempt>();

        for (const attempt of refundAttempts || []) {
            if (!this.isActiveInvalidBuyRefundReason(attempt.reasonCode)) {
                continue;
            }

            if (!latestByReason.has(attempt.reasonCode)) {
                latestByReason.set(attempt.reasonCode, {
                    id: attempt.id,
                    reasonCode: attempt.reasonCode,
                    retryCount: attempt.retryCount ?? 0,
                });
            }
        }

        return Array.from(latestByReason.values());
    }

    private isActiveInvalidBuyRefundReason(
        reasonCode: string,
    ): reasonCode is (typeof BuyOrderService.ACTIVE_INVALID_BUY_REFUND_REASONS)[number] {
        return (BuyOrderService.ACTIVE_INVALID_BUY_REFUND_REASONS as readonly string[]).includes(
            reasonCode,
        );
    }

    private getLatestActiveInvalidRefundAttemptForReason(
        refundAttempts: Array<{
            id: number;
            reasonCode: string;
            retryCount?: number | null;
        }> | null | undefined,
        reasonCode: BuyRefundReasonCode,
    ): ActiveInvalidRefundAttempt | null {
        return (
            this.getLatestActiveInvalidRefundAttempts(refundAttempts).find(
                (attempt) => attempt.reasonCode === reasonCode,
            ) || null
        );
    }

    private getCombinedInvalidPaymentCount(
        refundAttempts?: Array<{
            id: number;
            reasonCode: string;
            retryCount?: number | null;
        }> | null,
    ): number {
        return this.getLatestActiveInvalidRefundAttempts(refundAttempts).reduce(
            (total, attempt) => total + attempt.retryCount + 1,
            0,
        );
    }

    private hasMixedInvalidPaymentReasons(
        refundAttempts: Array<{
            id: number;
            reasonCode: string;
            retryCount?: number | null;
        }> | null | undefined,
        currentReasonCode: BuyRefundReasonCode,
    ): boolean {
        const reasonCodes = new Set(
            this.getLatestActiveInvalidRefundAttempts(refundAttempts).map(
                (attempt) => attempt.reasonCode,
            ),
        );
        reasonCodes.add(currentReasonCode);
        return reasonCodes.size > 1;
    }

    async handleWebhookBuyOrderPayment(options: {
        payment: BuyWebhookPayment;
        event: NormalizedPaymentEvent;
        reference: string;
        provider: InboundPaymentProvider;
    }): Promise<void> {
        const { payment, event, reference, provider } = options;
        const expectedAmount = Number(payment.totalAmount);

        if (this.isDuplicateRefundWebhook(payment, event)) {
            this.logger.log(
                `Ignoring duplicate refunded BUY payment webhook for reference: ${reference}`,
            );
            return;
        }

        if (
            payment.status === TransactionStatus.FAILED ||
            payment.status === TransactionStatus.REVERSAL ||
            this.isBuyPaymentExpired(payment.createdAt)
        ) {
            await this.handleExpiredWebhookBuyPaymentRefund({
                payment,
                event,
                reference,
                provider,
                expectedAmount,
            });
            return;
        }

        if (this.isWrongBuyPaymentAmount(event.amount, expectedAmount)) {
            await this.handleActiveWrongAmountWebhookPayment({
                payment,
                event,
                reference,
                provider,
                expectedAmount,
            });
            return;
        }

        const exactAmountReceived = this.isExactBuyPaymentAmount(
            event.amount,
            expectedAmount,
        )
            ? event.amount
            : null;

        if (exactAmountReceived !== null) {
            const paymentContext = await this.getBuyPaymentWithContext(reference);

            if (paymentContext?.order) {
                const nameMatch = this.evaluateBuyPaymentAccountNameMatch({
                    user: paymentContext.user,
                    senderAccountName:
                        event.senderAccountName
                        || paymentContext.senderAccountName
                        || null,
                });

                if (!nameMatch.matched) {
                    await this.handleAccountNameMismatchWebhookPayment({
                        payment: paymentContext,
                        event,
                        reference,
                        provider,
                        expectedAmount,
                        receivedAmount: exactAmountReceived,
                        nameMatch,
                    });
                    return;
                }
            } else {
                this.logger.warn(
                    `Unable to load BUY payment context for account-name validation reference: ${reference}; proceeding with fulfillment`,
                );
            }
        }

        const paymentUpdateData = this.buildWebhookPaymentUpdateData(event);
        if (Object.keys(paymentUpdateData).length > 0) {
            await this.prisma.payment.update({
                where: { id: payment.id },
                data: paymentUpdateData,
            });
        }

        await this.fulfillBuyOrder(reference);
    }

    private async handleActiveWrongAmountWebhookPayment(options: {
        payment: BuyWebhookPayment;
        event: NormalizedPaymentEvent;
        reference: string;
        provider: InboundPaymentProvider;
        expectedAmount: number;
    }): Promise<void> {
        const { payment, event, reference, provider, expectedAmount } = options;
        const receivedAmount = Number(event.amount);
        const narration = this.buildWrongAmountRefundNarration(
            receivedAmount,
            expectedAmount,
        );
        const paymentUpdateData = this.buildWebhookPaymentUpdateData(event);

        const updated = await this.prisma.payment.updateMany({
            where: {
                id: payment.id,
                status: TransactionStatus.PENDING,
            },
            data: {
                ...paymentUpdateData,
                paymentStatus: TransactionStatus.REVERSAL,
                narration,
            },
        });

        if (updated.count === 0) {
            this.logger.warn(
                `Skipping active wrong-amount refund for ${reference} — payment no longer PENDING`,
            );
            return;
        }

        const paymentContext = await this.getBuyPaymentWithContext(reference);
        if (!paymentContext?.order) {
            this.logger.warn(
                `Unable to load BUY payment context for wrong-amount refund reference: ${reference}`,
            );
            return;
        }

        const varianceLabel =
            receivedAmount < expectedAmount ? "underpayment" : "overpayment";
        const activeWrongAmountAttempt =
            this.getLatestActiveInvalidRefundAttemptForReason(
                paymentContext.refundAttempts,
                BUY_REFUND_REASON.ACTIVE_WRONG_AMOUNT,
            );
        const nextWrongAmountRetryCount = activeWrongAmountAttempt
            ? activeWrongAmountAttempt.retryCount + 1
            : 0;
        const nextCombinedInvalidPaymentCount =
            this.getCombinedInvalidPaymentCount(paymentContext.refundAttempts) + 1;

        if (
            nextCombinedInvalidPaymentCount
            >= BuyOrderService.MAX_ACTIVE_WRONG_AMOUNT_RESENDS + 1
        ) {
            if (activeWrongAmountAttempt) {
                await this.prisma.refundAttempt.update({
                    where: { id: activeWrongAmountAttempt.id },
                    data: { retryCount: nextWrongAmountRetryCount },
                });
            }

            await this.handleActiveWrongAmountRetryCapReached({
                payment: paymentContext,
                provider,
                expectedAmount,
                receivedAmount,
                varianceLabel,
                retryCount: nextWrongAmountRetryCount,
                combinedInvalidPaymentCount: nextCombinedInvalidPaymentCount,
                mixedInvalidReasons: this.hasMixedInvalidPaymentReasons(
                    paymentContext.refundAttempts,
                    BUY_REFUND_REASON.ACTIVE_WRONG_AMOUNT,
                ),
                reference,
            });
            return;
        }

        if (activeWrongAmountAttempt) {
            await this.prisma.refundAttempt.update({
                where: { id: activeWrongAmountAttempt.id },
                data: { retryCount: nextWrongAmountRetryCount },
            });
        }

        await this.buyRefundOrchestratorService.ensureRefundPayoutForPayment({
            paymentId: paymentContext.id,
            provider,
            reasonCode: BUY_REFUND_REASON.ACTIVE_WRONG_AMOUNT,
            refundAmount: receivedAmount,
            metadata: {
                expectedAmount,
                receivedAmount,
                varianceLabel,
                wrongAmountRetryCount: nextWrongAmountRetryCount,
                combinedInvalidPaymentCount: nextCombinedInvalidPaymentCount,
            },
        });
        const userMessage =
            `We received ₦${receivedAmount} for buy order ${paymentContext.order.transactionId}, ` +
            `but an exact payment of ₦${expectedAmount} is required. ` +
            `Your order remains open until the payment window expires, ` +
            `so resend the exact amount to complete the order.`;

        await this.notificationDispatcher.notify({
            userId: paymentContext.userId,
            title: "Incorrect payment amount received",
            body: userMessage,
            category: "transaction",
            currency: paymentContext.order.currency,
            transactionType: OrderCategory.BUY,
            enableEmail: true,
            emailPayload: {
                email: paymentContext.user?.email || "",
                transactionType: "buy",
                transactionId: paymentContext.order.transactionId,
                amount: String(paymentContext.order.amount),
                currency: paymentContext.order.currency?.toUpperCase() || "",
                status: "pending",
                date: new Date().toISOString(),
                notice: userMessage,
            },
            enablePush: true,
        });

        await this.slackWebhookService.sendWebhookFailureAlert(
            provider,
            reference,
            `${varianceLabel}: received ₦${receivedAmount} but expected exact ₦${expectedAmount}. ` +
                `Refund required; order remains open for resend until expiry.`,
            {
                orderId: paymentContext.orderId,
                userId: paymentContext.userId,
                expectedAmount,
                receivedAmount,
                senderAccountNumber: event.senderAccountNumber,
                senderAccountName: event.senderAccountName,
                senderBankName: event.senderBankName,
                externalReference: event.providerReference,
            },
        );
    }

    private async handleAccountNameMismatchWebhookPayment(options: {
        payment: any;
        event: NormalizedPaymentEvent;
        reference: string;
        provider: InboundPaymentProvider;
        expectedAmount: number;
        receivedAmount: number;
        nameMatch: BuyAccountNameMatchResult;
    }): Promise<void> {
        const {
            payment,
            event,
            reference,
            provider,
            expectedAmount,
            receivedAmount,
            nameMatch,
        } = options;
        const narration = this.buildActiveAccountNameMismatchRefundNarration(
            receivedAmount,
            expectedAmount,
            nameMatch.senderAccountName,
            nameMatch.registeredAccountName,
        );
        const paymentUpdateData = this.buildWebhookPaymentUpdateData(event);
        const updated = await this.prisma.payment.updateMany({
            where: {
                id: payment.id,
                status: TransactionStatus.PENDING,
            },
            data: {
                ...paymentUpdateData,
                paymentStatus: TransactionStatus.REVERSAL,
                narration,
            },
        });

        if (updated.count === 0) {
            this.logger.warn(
                `Skipping BUY account-name mismatch refund for ${reference} — payment no longer PENDING`,
            );
            return;
        }

        const activeNameMismatchAttempt =
            this.getLatestActiveInvalidRefundAttemptForReason(
                payment.refundAttempts,
                BUY_REFUND_REASON.ACCOUNT_NAME_MISMATCH,
            );
        const nextNameMismatchRetryCount = activeNameMismatchAttempt
            ? activeNameMismatchAttempt.retryCount + 1
            : 0;
        const nextCombinedInvalidPaymentCount =
            this.getCombinedInvalidPaymentCount(payment.refundAttempts) + 1;

        if (
            nextCombinedInvalidPaymentCount
            >= BuyOrderService.MAX_ACTIVE_WRONG_AMOUNT_RESENDS + 1
        ) {
            if (activeNameMismatchAttempt) {
                await this.prisma.refundAttempt.update({
                    where: { id: activeNameMismatchAttempt.id },
                    data: { retryCount: nextNameMismatchRetryCount },
                });
            }

            await this.handleActiveAccountNameMismatchRetryCapReached({
                payment,
                provider,
                expectedAmount,
                receivedAmount,
                nameMatch,
                retryCount: nextNameMismatchRetryCount,
                combinedInvalidPaymentCount: nextCombinedInvalidPaymentCount,
                mixedInvalidReasons: this.hasMixedInvalidPaymentReasons(
                    payment.refundAttempts,
                    BUY_REFUND_REASON.ACCOUNT_NAME_MISMATCH,
                ),
                reference,
            });
            return;
        }

        if (activeNameMismatchAttempt) {
            await this.prisma.refundAttempt.update({
                where: { id: activeNameMismatchAttempt.id },
                data: { retryCount: nextNameMismatchRetryCount },
            });
        }

        await this.buyRefundOrchestratorService.ensureRefundPayoutForPayment({
            paymentId: payment.id,
            provider,
            reasonCode: BUY_REFUND_REASON.ACCOUNT_NAME_MISMATCH,
            refundAmount: receivedAmount,
            metadata: {
                expectedAmount,
                receivedAmount,
                registeredAccountName: nameMatch.registeredAccountName,
                senderAccountName: nameMatch.senderAccountName,
                expectedNameTokens: nameMatch.expectedTokens,
                receivedNameTokens: nameMatch.actualTokens,
                missingExpectedNameTokens: nameMatch.missingExpectedTokens,
                nameMatchPolicy: "token-subset-fuzzy-v1",
                nameMismatchRetryCount: nextNameMismatchRetryCount,
                combinedInvalidPaymentCount: nextCombinedInvalidPaymentCount,
            },
        });

        const userMessage =
            `We received an invalid payment for buy order ${payment.order.transactionId}, ` +
            `and it did not meet the validation requirements to complete the order. ` +
            `Your order remains open until the payment window expires, so resend the exact amount from a bank account that matches your registered name to complete the order.`;

        await this.notificationDispatcher.notify({
            userId: payment.userId,
            title: "Invalid payment received",
            body: userMessage,
            category: "transaction",
            currency: payment.order.currency,
            transactionType: OrderCategory.BUY,
            enableEmail: true,
            emailPayload: {
                email: payment.user?.email || "",
                transactionType: "buy",
                transactionId: payment.order.transactionId,
                amount: String(payment.order.amount),
                currency: payment.order.currency?.toUpperCase() || "",
                status: "pending",
                date: new Date().toISOString(),
                notice: userMessage,
            },
            enablePush: true,
        });

        await this.slackWebhookService.sendWebhookFailureAlert(
            provider,
            reference,
            "Exact-amount BUY payment sender name did not match the registered account holder. Refund required; order remains open for resend until expiry.",
            {
                orderId: payment.orderId,
                userId: payment.userId,
                expectedAmount,
                receivedAmount,
                registeredAccountName: nameMatch.registeredAccountName,
                senderAccountName: nameMatch.senderAccountName,
                missingExpectedNameTokens: nameMatch.missingExpectedTokens,
                senderAccountNumber: event.senderAccountNumber,
                senderBankName: event.senderBankName,
                externalReference: event.providerReference,
            },
        );
    }

    private async handleActiveAccountNameMismatchRetryCapReached(options: {
        payment: any;
        provider: InboundPaymentProvider;
        expectedAmount: number;
        receivedAmount: number;
        nameMatch: BuyAccountNameMatchResult;
        retryCount: number;
        combinedInvalidPaymentCount: number;
        mixedInvalidReasons: boolean;
        reference: string;
    }): Promise<void> {
        const {
            payment,
            provider,
            expectedAmount,
            receivedAmount,
            nameMatch,
            retryCount,
            combinedInvalidPaymentCount,
            mixedInvalidReasons,
            reference,
        } = options;
        const narration = this.buildAccountNameMismatchRetryCapNarration(
            receivedAmount,
            expectedAmount,
            nameMatch.senderAccountName,
            nameMatch.registeredAccountName,
        );

        const didClose = await this.prisma.$transaction(async (tx) => {
            const updated = await tx.payment.updateMany({
                where: {
                    id: payment.id,
                    status: TransactionStatus.PENDING,
                },
                data: {
                    status: TransactionStatus.REVERSAL,
                    paymentStatus: TransactionStatus.REVERSAL,
                    narration,
                },
            });

            if (updated.count === 0) {
                return false;
            }

            await tx.order.update({
                where: { id: payment.orderId },
                data: {
                    status: OrderStatus.reversed,
                    streamlinedStatus: getStreamlinedStatus(
                        OrderStatus.reversed,
                    ),
                    paymentStatus: TransactionStatus.REVERSAL,
                    reason: narration,
                },
            });

            return true;
        });

        if (!didClose) {
            this.logger.warn(
                `Skipping account-name mismatch retry-cap closure for ${reference} — payment no longer PENDING`,
            );
            return;
        }

        await this.releaseReservedBuyLimit(payment);

        this.emitTransactionUpdate(payment.userId, {
            ...payment.order,
            status: OrderStatus.reversed,
            streamlinedStatus: getStreamlinedStatus(OrderStatus.reversed),
            updatedAt: new Date(),
        });

        await this.buyRefundOrchestratorService.ensureRefundPayoutForPayment({
            paymentId: payment.id,
            provider,
            reasonCode: BUY_REFUND_REASON.ACCOUNT_NAME_MISMATCH,
            refundAmount: receivedAmount,
            metadata: {
                expectedAmount,
                receivedAmount,
                registeredAccountName: nameMatch.registeredAccountName,
                senderAccountName: nameMatch.senderAccountName,
                expectedNameTokens: nameMatch.expectedTokens,
                receivedNameTokens: nameMatch.actualTokens,
                missingExpectedNameTokens: nameMatch.missingExpectedTokens,
                nameMatchPolicy: "token-subset-fuzzy-v1",
                nameMismatchRetryCount: retryCount,
                combinedInvalidPaymentCount,
                maxNameMismatchResendsReached: true,
                combinedInvalidPaymentCapReached: true,
                orderClosedByRetryCap: true,
            },
        });

        const userMessage =
            `We received another invalid payment for buy order ${payment.order.transactionId}, ` +
            `and the maximum resend limit has been reached. The order is now closed.`;

        await this.notificationDispatcher.notify({
            userId: payment.userId,
            title: "Buy order closed after repeated invalid payments",
            body: userMessage,
            category: "transaction",
            currency: payment.order.currency,
            transactionType: OrderCategory.BUY,
            enableEmail: true,
            emailPayload: {
                email: payment.user?.email || "",
                transactionType: "buy",
                transactionId: payment.order.transactionId,
                amount: String(payment.order.amount),
                currency: payment.order.currency?.toUpperCase() || "",
                status: "cancelled",
                date: new Date().toISOString(),
                notice: userMessage,
            },
            enablePush: true,
        });

        await this.slackWebhookService.sendWebhookFailureAlert(
            provider,
            reference,
            mixedInvalidReasons
                ? "Maximum combined invalid-payment resend cap reached; order closed as refunded."
                : "Maximum account-name mismatch resend cap reached; order closed as refunded.",
            {
                orderId: payment.orderId,
                userId: payment.userId,
                expectedAmount,
                receivedAmount,
                retryCount,
                combinedInvalidPaymentCount,
                registeredAccountName: nameMatch.registeredAccountName,
                senderAccountName: nameMatch.senderAccountName,
                missingExpectedNameTokens: nameMatch.missingExpectedTokens,
            },
        );
    }

    private async handleActiveWrongAmountRetryCapReached(options: {
        payment: any;
        provider: InboundPaymentProvider;
        expectedAmount: number;
        receivedAmount: number;
        varianceLabel: "underpayment" | "overpayment";
        retryCount: number;
        combinedInvalidPaymentCount: number;
        mixedInvalidReasons: boolean;
        reference: string;
    }): Promise<void> {
        const {
            payment,
            provider,
            expectedAmount,
            receivedAmount,
            varianceLabel,
            retryCount,
            combinedInvalidPaymentCount,
            mixedInvalidReasons,
            reference,
        } = options;
        const narration = this.buildWrongAmountRetryCapNarration(
            receivedAmount,
            expectedAmount,
        );

        const didClose = await this.prisma.$transaction(async (tx) => {
            const updated = await tx.payment.updateMany({
                where: {
                    id: payment.id,
                    status: TransactionStatus.PENDING,
                },
                data: {
                    status: TransactionStatus.REVERSAL,
                    paymentStatus: TransactionStatus.REVERSAL,
                    narration,
                },
            });

            if (updated.count === 0) {
                return false;
            }

            await tx.order.update({
                where: { id: payment.orderId },
                data: {
                    status: OrderStatus.reversed,
                    streamlinedStatus: getStreamlinedStatus(
                        OrderStatus.reversed,
                    ),
                    paymentStatus: TransactionStatus.REVERSAL,
                    reason: narration,
                },
            });

            return true;
        });

        if (!didClose) {
            this.logger.warn(
                `Skipping wrong-amount retry-cap closure for ${reference} — payment no longer PENDING`,
            );
            return;
        }

        await this.releaseReservedBuyLimit(payment);

        this.emitTransactionUpdate(payment.userId, {
            ...payment.order,
            status: OrderStatus.reversed,
            streamlinedStatus: getStreamlinedStatus(OrderStatus.reversed),
            updatedAt: new Date(),
        });

        await this.buyRefundOrchestratorService.ensureRefundPayoutForPayment({
            paymentId: payment.id,
            provider,
            reasonCode: BUY_REFUND_REASON.ACTIVE_WRONG_AMOUNT,
            refundAmount: receivedAmount,
            metadata: {
                expectedAmount,
                receivedAmount,
                varianceLabel,
                wrongAmountRetryCount: retryCount,
                combinedInvalidPaymentCount,
                maxWrongAmountResendsReached: true,
                combinedInvalidPaymentCapReached: true,
                orderClosedByRetryCap: true,
            },
        });
        const userMessage = mixedInvalidReasons
            ? `We received another invalid payment for buy order ${payment.order.transactionId}, and the maximum resend limit has been reached. The order is now closed.`
            : `We received another incorrect payment of ₦${receivedAmount} for buy order ${payment.order.transactionId}, and the maximum wrong-amount resend limit has been reached. The order is now closed.`;

        await this.notificationDispatcher.notify({
            userId: payment.userId,
            title: mixedInvalidReasons
                ? "Buy order closed after repeated invalid payments"
                : "Buy order closed after repeated incorrect payments",
            body: userMessage,
            category: "transaction",
            currency: payment.order.currency,
            transactionType: OrderCategory.BUY,
            enableEmail: true,
            emailPayload: {
                email: payment.user?.email || "",
                transactionType: "buy",
                transactionId: payment.order.transactionId,
                amount: String(payment.order.amount),
                currency: payment.order.currency?.toUpperCase() || "",
                status: "cancelled",
                date: new Date().toISOString(),
                notice: userMessage,
            },
            enablePush: true,
        });

        await this.slackWebhookService.sendWebhookFailureAlert(
            provider,
            reference,
            mixedInvalidReasons
                ? "Maximum combined invalid-payment resend cap reached; order closed as refunded."
                : "Maximum wrong-amount resend cap reached; order closed as refunded.",
            {
                orderId: payment.orderId,
                userId: payment.userId,
                expectedAmount,
                receivedAmount,
                retryCount,
                combinedInvalidPaymentCount,
                senderAccountNumber: payment.senderAccountNumber,
                senderAccountName: payment.senderAccountName,
                senderBankName: payment.senderBankName,
            },
        );
    }

    private async handleExpiredWebhookBuyPaymentRefund(options: {
        payment: BuyWebhookPayment;
        event: NormalizedPaymentEvent;
        reference: string;
        provider: InboundPaymentProvider;
        expectedAmount: number;
    }): Promise<void> {
        const { payment, event, reference, provider, expectedAmount } = options;
        const paymentContext = await this.getBuyPaymentWithContext(reference);

        if (!paymentContext?.order) {
            this.logger.warn(
                `Unable to load BUY payment context for expired payment refund reference: ${reference}`,
            );
            return;
        }

        const receivedAmount = this.isPositiveFiatAmount(event.amount)
            ? event.amount
            : this.buildManualRefundAlertAmount(paymentContext);
        const refundPolicy = this.resolveClosedBuyRefundPolicy({
            payment,
            order: paymentContext.order,
            refundAttempts: paymentContext.refundAttempts,
            expectedAmount,
            receivedAmount,
        });
        const narration = refundPolicy.narration;
        const paymentUpdateData = this.buildWebhookPaymentUpdateData(event);
        const closeFromPending = payment.status === TransactionStatus.PENDING;

        if (closeFromPending) {
            const didClose = await this.prisma.$transaction(async (tx) => {
                const updated = await tx.payment.updateMany({
                    where: {
                        id: payment.id,
                        status: TransactionStatus.PENDING,
                    },
                    data: {
                        ...paymentUpdateData,
                        status: TransactionStatus.REVERSAL,
                        paymentStatus: TransactionStatus.REVERSAL,
                        narration,
                    },
                });

                if (updated.count === 0) {
                    return false;
                }

                await tx.order.update({
                    where: { id: paymentContext.orderId },
                    data: {
                        status: OrderStatus.reversed,
                        streamlinedStatus: getStreamlinedStatus(
                            OrderStatus.reversed,
                        ),
                        paymentStatus: TransactionStatus.REVERSAL,
                        reason: narration,
                    },
                });

                return true;
            });

            if (!didClose) {
                this.logger.warn(
                    `Skipping expired BUY refund for ${reference} — payment no longer PENDING`,
                );
                return;
            }

            await this.releaseReservedBuyLimit(paymentContext);
        } else {
            await this.prisma.$transaction(async (tx) => {
                await tx.payment.update({
                    where: { id: payment.id },
                    data: {
                        ...paymentUpdateData,
                        status: TransactionStatus.REVERSAL,
                        paymentStatus: TransactionStatus.REVERSAL,
                        narration,
                    },
                });

                await tx.order.update({
                    where: { id: paymentContext.orderId },
                    data: {
                        status: OrderStatus.reversed,
                        streamlinedStatus: getStreamlinedStatus(
                            OrderStatus.reversed,
                        ),
                        paymentStatus: TransactionStatus.REVERSAL,
                        reason: narration,
                    },
                });
            });
        }

        this.emitTransactionUpdate(paymentContext.userId, {
            ...paymentContext.order,
            status: OrderStatus.reversed,
            streamlinedStatus: getStreamlinedStatus(OrderStatus.reversed),
            updatedAt: new Date(),
        });

        await this.buyRefundOrchestratorService.ensureRefundPayoutForPayment({
            paymentId: paymentContext.id,
            provider,
            reasonCode: refundPolicy.reasonCode,
            refundAmount: receivedAmount,
            metadata: {
                expectedAmount,
                receivedAmount,
                closedOrder: true,
                closedOrderReason: refundPolicy.closedOrderReason,
            },
        });

        if (closeFromPending) {
            const userMessage =
                `We received ₦${receivedAmount} for buy order ${paymentContext.order.transactionId} ` +
                `after the payment window expired. The order is now closed.`;

            await this.notificationDispatcher.notify({
                userId: paymentContext.userId,
                title: "Buy order expired",
                body: userMessage,
                category: "transaction",
                currency: paymentContext.order.currency,
                transactionType: OrderCategory.BUY,
                enableEmail: true,
                emailPayload: {
                    email: paymentContext.user?.email || "",
                    transactionType: "buy",
                    transactionId: paymentContext.order.transactionId,
                    amount: String(paymentContext.order.amount),
                    currency: paymentContext.order.currency?.toUpperCase() || "",
                    status: "cancelled",
                    date: new Date().toISOString(),
                    notice: userMessage,
                },
                enablePush: true,
            });
        }

        await this.slackWebhookService.sendWebhookFailureAlert(
            provider,
            reference,
            refundPolicy.slackMessage,
            {
                orderId: paymentContext.orderId,
                userId: paymentContext.userId,
                expectedAmount,
                receivedAmount,
                closedOrderReason: refundPolicy.closedOrderReason,
                senderAccountNumber: event.senderAccountNumber,
                senderAccountName: event.senderAccountName,
                senderBankName: event.senderBankName,
                externalReference: event.providerReference,
            },
        );
    }

    /**
     * Gets a fee based on amount and fee data structure
     */
    private async getFee(
        amount: number,
        data: any,
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
            return this.calculateRangeFee(amount, data.fee);
        }

        // Fallback for simple fee structures
        if (typeof data.fee === "number") {
            return { fee: data.fee, type: "fixed" };
        }

        throw new IncompleteAccountSetupException(
            "Unknown fee structure",
            HttpStatus.INTERNAL_SERVER_ERROR,
        );
    }

    private calculateRangeFee(
        amount: number,
        ranges: { min: number; max: number; type: string; value: number }[],
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
            HttpStatus.BAD_REQUEST,
        );
    }

    /**
     * Gets the amount converted to Naira
     */
    private async getAmountInNaira(
        currency: string,
        amount: number,
    ): Promise<{ amount: number; rate: number } | null> {
        try {
            const rate = await this.rateService.getAssetRate(
                currency.toUpperCase(),
            );
            return {
                amount: amount * rate.sellRate,
                rate: rate.sellRate,
            };
        } catch {
            return null;
        }
    }

    private async getFallbackBuyWalletAddress(options: {
        userId: number;
        assetSymbol: string;
        normalizedDefaultNetwork: string | null;
    }): Promise<{
        address: string | null;
        network: string | null;
        destination_tag: string | null;
    } | null> {
        const { userId, assetSymbol, normalizedDefaultNetwork } = options;

        if (normalizedDefaultNetwork) {
            return this.prisma.cryptoWalletAddress.findFirst({
                where: {
                    userId,
                    assetSymbol,
                    status: CryptoWalletStatus.ACTIVE,
                    address: { not: null },
                    network: normalizedDefaultNetwork as any,
                },
                select: {
                    address: true,
                    network: true,
                    destination_tag: true,
                },
                orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
            });
        }

        const fallbackWalletAddresses =
            await this.prisma.cryptoWalletAddress.findMany({
                where: {
                    userId,
                    assetSymbol,
                    status: CryptoWalletStatus.ACTIVE,
                    address: { not: null },
                    network: { not: null },
                },
                select: {
                    address: true,
                    network: true,
                    destination_tag: true,
                },
                orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
            });

        if (fallbackWalletAddresses.length <= 1) {
            return fallbackWalletAddresses[0] ?? null;
        }

        this.logger.warn(
            `Ambiguous buy wallet fallback for user ${userId} asset ${assetSymbol}; refusing to choose between ${fallbackWalletAddresses.length} active network addresses`,
        );

        throw new WalletAddressNotFoundException(
            `Unable to determine a safe wallet address for asset ${assetSymbol}. Please try again shortly.`,
            HttpStatus.CONFLICT,
        );
    }

    private isSameCryptoAmount(
        requestedAmount: number,
        existingAmount?: number | null,
    ): boolean {
        if (typeof existingAmount !== "number") return false;
        return (
            Math.abs(requestedAmount - existingAmount) <=
            BuyOrderService.CRYPTO_AMOUNT_TOLERANCE
        );
    }

    private ensureIdempotentRequestMatchesExistingOrder(
        dto: BuyCryptoOrderDto,
        existingPayment: {
            order: { amount?: number | null; currency?: string | null } | null;
            paymentMethod?: PaymentMethod | null;
        },
    ) {
        if (!existingPayment.order) {
            throw new BadRequestException(
                "Idempotency key is linked to an invalid order state",
            );
        }

        const requestedAsset = dto.asset.toUpperCase();
        const existingAsset = existingPayment.order.currency?.toUpperCase();
        if (existingAsset !== requestedAsset) {
            throw new BadRequestException(
                "Idempotency key already used for a different asset",
            );
        }

        if (
            !this.isSameCryptoAmount(dto.amount, existingPayment.order.amount)
        ) {
            throw new BadRequestException(
                "Idempotency key already used with a different amount",
            );
        }

        if (
            dto.paymentMethod &&
            existingPayment.paymentMethod &&
            existingPayment.paymentMethod !== dto.paymentMethod
        ) {
            throw new BadRequestException(
                "Idempotency key already used with a different payment method",
            );
        }
    }

    /**
     * Gets a quote request for buying crypto
     */
    async buyCryptoQuoteRequest(user: User, dto: InitiateBuyOrderDto) {
        const responseData = await this.calculateBuyQuote(user, dto);

        return buildResponse({
            message: "Quotation for buy order retrieved successfully",
            data: responseData,
        });
    }

    /**
     * Calculates the quote for a buy order
     */
    async calculateBuyQuote(
        user: User,
        dto: InitiateBuyOrderDto,
    ): Promise<BuyQuoteResponse> {
        const currency = this.tradeHelpers.ensureSupportedTradeAsset(
            dto.asset,
            "buy",
        );
        const paymentMethod = this.resolveBuyPaymentMethod(dto.paymentMethod);

        // sell rate is used when user is buying.
        const rate = await this.rateService.getAssetRate(currency);

        // Zero out fees for buy orders as requested
        const quidaxFeeInCrypto = { fee: 0, type: "flat" };
        const adminFeeInCrypto = { fee: 0 };

        const assetValueInNaira = dto.amount * rate.sellRate;
        const quidaxFeeInNaira = 0;
        const adminFeeInNaira = 0;

        const totalToChargeInCrypto =
            dto.amount + quidaxFeeInCrypto.fee + adminFeeInCrypto.fee;
        const totalToChargeViaPaymentGateway =
            assetValueInNaira + quidaxFeeInNaira + adminFeeInNaira;

        return {
            buyRate: rate.sellRate,
            cryptoBuyAmount: dto.amount,
            transactionFeeInCrypto:
                quidaxFeeInCrypto.fee + adminFeeInCrypto.fee,
            totalToChargeInCrypto,
            totalToChargeViaPaymentGateway,
            currency: "NGN",
            paymentGateway: paymentMethod,
            availablePaymentMethods: this.getAvailableBuyPaymentMethods(),
        };
    }

    /**
     * Places a buy order for crypto
     * Creates provider-specific payment instructions for the user to complete.
     * Returns either temporary virtual account details or a hosted checkout URL.
     */
    async buyCryptoOrder(user: User, dto: BuyCryptoOrderDto) {
        return this.distributedLockService.withLock(
            `trade:buy:${user.id}`,
            async () => {
                const reservationCreatedAt = new Date();
                const reservationAmount =
                    typeof dto.amount === "number" && Number.isFinite(dto.amount)
                        ? dto.amount
                        : null;
                let reservationCurrency =
                    typeof dto.asset === "string" && dto.asset.trim()
                        ? dto.asset.trim().toUpperCase()
                        : null;
                let paymentGatewayData: InboundPaymentInitializationResult | null =
                    null;
                let orderPersisted = false;

                try {
                    const normalizedAsset =
                        this.tradeHelpers.ensureSupportedTradeAsset(
                            dto.asset,
                            "buy",
                        );
                    reservationCurrency = normalizedAsset;
                    const selectedPaymentMethod = this.resolveBuyPaymentMethod(
                        dto.paymentMethod,
                    );

                    // IDEMPOTENCY CHECK: Return existing order if same idempotencyKey was already used
                    if (dto.idempotencyKey) {
                        const existingPayment =
                            await this.prisma.payment.findUnique({
                                where: { idempotencyKey: dto.idempotencyKey },
                                include: { order: true },
                            });

                        if (existingPayment?.order) {
                            if (existingPayment.userId !== user.id) {
                                throw new BadRequestException(
                                    "Idempotency key belongs to a different user",
                                );
                            }

                            this.ensureIdempotentRequestMatchesExistingOrder(dto, {
                                order: {
                                    amount: existingPayment.order.amount,
                                    currency: existingPayment.order.currency,
                                },
                                paymentMethod: existingPayment.paymentMethod,
                            });

                            this.logger.warn(
                                `Duplicate buy request detected (Idempotency Key: ${dto.idempotencyKey}) - Returning existing order`,
                            );

                            await this.releaseReservedBuyRequestLimit({
                                userId: user.id,
                                currency: reservationCurrency,
                                amount: reservationAmount,
                                createdAt: reservationCreatedAt,
                            }).catch((releaseError) => {
                                this.logger.error(
                                    `Failed to release reserved BUY limit after idempotent reuse for user ${user.id}: ${
                                        releaseError instanceof Error
                                            ? releaseError.message
                                            : String(releaseError)
                                    }`,
                                );
                            });

                            return this.buildExistingOrderResponse(existingPayment);
                        }
                    }

                    // Minimum amount validation
                    await this.tradeHelpers.validateMinimumAmountInUSDT(
                        dto.amount,
                        normalizedAsset,
                        MIN_BUY_AMOUNT_USDT,
                        "buy",
                    );

                    // EXISTING PENDING ORDER GUARD: Prevent duplicate orders for the same asset + amount
                    // Catches cases where frontend generates a new idempotencyKey (e.g. modal re-opened)
                    // but user already has a non-expired pending buy order for the same asset and amount.
                    const existingPendingPayment =
                        await this.prisma.payment.findFirst({
                            where: {
                                userId: user.id,
                                status: TransactionStatus.PENDING,
                                paymentMethod: {
                                    in: this.getSupportedBuyPaymentMethods(),
                                },
                                type: TransactionType.P2P_PAYMENT,
                                orderId: { not: null },
                                order: {
                                    orderCategory: OrderCategory.BUY,
                                    currency: normalizedAsset,
                                    status: OrderStatus.pending,
                                    amount: {
                                        gte:
                                            dto.amount -
                                            BuyOrderService.CRYPTO_AMOUNT_TOLERANCE,
                                        lte:
                                            dto.amount +
                                            BuyOrderService.CRYPTO_AMOUNT_TOLERANCE,
                                    },
                                },
                                // Only consider orders within the VA expiry window (35 min)
                                createdAt: {
                                    gt: new Date(Date.now() - 35 * 60 * 1000),
                                },
                            },
                            include: { order: true },
                            orderBy: {
                                createdAt: "desc",
                            },
                        });

                    if (existingPendingPayment?.order) {
                        this.logger.warn(
                            `User ${user.id} already has a pending buy order for ${normalizedAsset} (Order: ${existingPendingPayment.orderId}) - Returning existing order`,
                        );

                        await this.releaseReservedBuyRequestLimit({
                            userId: user.id,
                            currency: reservationCurrency,
                            amount: reservationAmount,
                            createdAt: reservationCreatedAt,
                        }).catch((releaseError) => {
                            this.logger.error(
                                `Failed to release reserved BUY limit after pending-order reuse for user ${user.id}: ${
                                    releaseError instanceof Error
                                        ? releaseError.message
                                        : String(releaseError)
                                }`,
                            );
                        });

                        return this.buildExistingOrderResponse(
                            existingPendingPayment,
                        );
                    }

                    const responseData = await this.calculateBuyQuote(user, {
                        ...dto,
                        asset: normalizedAsset,
                        paymentMethod: selectedPaymentMethod,
                    });

                    const userData = {
                        id: user.id,
                        firstName: user.firstName,
                        lastName: user.lastName,
                        email: user.email,
                        phoneNumber: user.phone,
                    };

                    const amount = +responseData.totalToChargeViaPaymentGateway;
                    Logger.log(`amount: ${typeof amount}`);

                    paymentGatewayData =
                        await this.inboundFiatPaymentService.initializePayment({
                            provider: this.getBuyPaymentProvider(
                                selectedPaymentMethod,
                            ),
                            user: userData,
                            amount,
                            callbackUrl: frontendUrl,
                            modePreference: "virtual_account",
                            allowCheckoutFallback: true,
                        });

                    const amtFiat = await this.getAmountInNaira(
                        normalizedAsset,
                        responseData.cryptoBuyAmount,
                    );

                    const order = await this.prisma.$transaction(
                        async (tx) => {
                            const order = await tx.order.create({
                                data: {
                                    orderCategory: OrderCategory.BUY,
                                    transactionId: generateId({
                                        type: "transaction",
                                    }),
                                    amount: responseData.cryptoBuyAmount,
                                    fee: responseData.transactionFeeInCrypto,
                                    total: responseData.totalToChargeInCrypto,
                                    status: OrderStatus.pending,
                                    streamlinedStatus: getStreamlinedStatus(
                                        OrderStatus.pending,
                                    ),
                                    paymentStatus: TransactionStatus.PENDING,
                                    currency: dto.asset.toUpperCase(),

                                    userId: user.id,
                                    amountInFiat: amtFiat?.amount,
                                    rateAtConversion: amtFiat?.rate,
                                    narration: `Buy ${responseData.cryptoBuyAmount} ${dto.asset.toUpperCase()}`,
                                    transaction_note: `Buy ${responseData.cryptoBuyAmount} ${dto.asset.toUpperCase()}`,
                                    sender: `${user.lastName} ${user.firstName}`,
                                },
                            });
                            await tx.payment.create({
                                data: {
                                    reference: paymentGatewayData.reference,
                                    userId: user.id,
                                    amount:
                                        responseData.buyRate *
                                        responseData.cryptoBuyAmount,
                                    chargeFee:
                                        responseData.buyRate *
                                        responseData.transactionFeeInCrypto,
                                    totalAmount:
                                        responseData.totalToChargeViaPaymentGateway,
                                    type: TransactionType.P2P_PAYMENT,
                                    status: TransactionStatus.PENDING,
                                    paymentStatus: TransactionStatus.PENDING,
                                    paymentMethod: getPaymentMethodForBankProvider(
                                        paymentGatewayData.provider,
                                    ),
                                    sessionId: generateId({ type: "sessionId" }),
                                    transactionId: generateId({
                                        type: "transaction",
                                    }),
                                    title: `${COMPANY_NAME} p2p buy order payment`,
                                    narration: `Buy order payment for order with id ${order.id}`,
                                    orderId: order.id,
                                    isDebit: false,
                                    expectedCurrency: responseData.currency,
                                    idempotencyKey: dto.idempotencyKey || null,
                                    externalReference:
                                        paymentGatewayData.mode === "checkout"
                                            ? paymentGatewayData.authorizationUrl
                                            : null,
                                    providerAccountReference:
                                        paymentGatewayData.mode ===
                                        "virtual_account"
                                            ? paymentGatewayData.providerAccountReference
                                            : null,
                                    destinationBankAccountNumber:
                                        paymentGatewayData.mode ===
                                        "virtual_account"
                                            ? paymentGatewayData.accountNumber
                                            : null,
                                    destinationBankAccountName:
                                        paymentGatewayData.mode ===
                                        "virtual_account"
                                            ? paymentGatewayData.accountName
                                            : null,
                                    destinationBankName:
                                        paymentGatewayData.mode ===
                                        "virtual_account"
                                            ? paymentGatewayData.bankName
                                            : null,
                                },
                            });

                            return order;
                        },
                        {
                            maxWait: DEFAULT_TRANSACTION_MAX_WAIT_MS,
                            timeout: EXTENDED_TRANSACTION_TIMEOUT_MS,
                        },
                    );
                    orderPersisted = true;

                    // Emit transaction update for new buy order
                    this.emitTransactionUpdate(user.id, order);

                    // Emit wallet update for buy order initiation
                    this.wsGateway.notifyWalletUpdate(user.id);

                    // Create and send notification for processing
                    const message = `Your buy order of ${
                        order.amount
                    } ${order.currency.toUpperCase()} is pending payment. Transaction ID: ${
                        order.transactionId
                    }`;

                    await this.notificationDispatcher.notify({
                        userId: user.id,
                        title: "Buy order initiated",
                        body: message,
                        category: "transaction",
                        currency: order.currency,
                        transactionType: OrderCategory.BUY,
                        enablePush: true,
                    });

                    // Generate USSD code if bank is supported
                    const ussdCode =
                        paymentGatewayData.mode === "virtual_account"
                            ? generateUssdCode(
                                  paymentGatewayData.bankCode,
                                  paymentGatewayData.accountNumber,
                                  amount,
                              )
                            : null;

                    return buildResponse({
                        message:
                            "Order placed successfully, Please proceed to make payment",
                        data: {
                            order: order,
                            paymentInfo:
                                paymentGatewayData.mode === "virtual_account"
                                    ? {
                                          reference: paymentGatewayData.reference,
                                          accountNumber:
                                              paymentGatewayData.accountNumber,
                                          accountName:
                                              paymentGatewayData.accountName,
                                          bankName: paymentGatewayData.bankName,
                                          bankCode: paymentGatewayData.bankCode,
                                          amount,
                                          expiryAt: paymentGatewayData.expiryAt,
                                          ussdCode,
                                      }
                                    : {
                                          authorization_url:
                                              paymentGatewayData.authorizationUrl,
                                          reference: paymentGatewayData.reference,
                                          amount: paymentGatewayData.amount,
                                          expiryAt: paymentGatewayData.expiryAt,
                                          ussdCode: null,
                                      },
                        },
                    });
                } catch (error) {
                    if (!orderPersisted) {
                        await this.releaseReservedBuyRequestLimit({
                            userId: user.id,
                            currency: reservationCurrency,
                            amount: reservationAmount,
                            createdAt: reservationCreatedAt,
                        }).catch((releaseError) => {
                            this.logger.error(
                                `Failed to release reserved BUY limit after order creation error for user ${user.id}: ${
                                    releaseError instanceof Error
                                        ? releaseError.message
                                        : String(releaseError)
                                }`,
                            );
                        });

                        if (paymentGatewayData) {
                            await this.inboundFiatPaymentService
                                .cleanupPendingPayment({
                                    provider: paymentGatewayData.provider,
                                    reference:
                                        ("providerAccountReference"
                                            in paymentGatewayData
                                            ? paymentGatewayData.providerAccountReference
                                            : null) ||
                                        paymentGatewayData.reference,
                                })
                                .catch((cleanupError) => {
                                    this.logger.error(
                                        `Failed to cleanup pending BUY payment artifact for user ${user.id}: ${
                                            cleanupError instanceof Error
                                                ? cleanupError.message
                                                : String(cleanupError)
                                        }`,
                                    );
                                });
                        }
                    }

                    throw error;
                }
            },
            { ttlMs: 30000, maxWaitMs: 5000, strict: true },
        );
    }

    /**
     * Fulfills a buy order after successful payment
     *
     * Uses atomic update to prevent double-fulfillment from duplicate webhooks.
     */
    async fulfillBuyOrder(reference: string) {
        this.logger.log(
            `Fulfilling buy order for payment reference: ${reference}`,
        );

        // Atomic: Only update if status is still PENDING.
        // This prevents race conditions where duplicate webhooks could both
        // pass a non-atomic check and double-credit the user.
        // We use APPROVED as an intermediate "claimed" status - only mark SUCCESS
        // after Quidax transfer succeeds. If Quidax fails, we revert to PENDING
        // and throw so the webhook handler returns 5xx and Nomba retries.
        const updated = await this.prisma.payment.updateMany({
            where: {
                reference,
                status: TransactionStatus.PENDING,
            },
            data: {
                status: TransactionStatus.APPROVED, // Intermediate: claimed for processing
                paymentStatus: TransactionStatus.APPROVED,
            },
        });

        if (updated.count === 0) {
            // Either payment not found, already processed (SUCCESS), or being processed (APPROVED)
            const existing = await this.prisma.payment.findUnique({
                where: { reference },
            });
            if (!existing) {
                this.logger.error(
                    `Payment not found for reference: ${reference}`,
                );
            } else if (existing.status === TransactionStatus.SUCCESS) {
                this.logger.log(
                    `Payment ${reference} already completed successfully`,
                );
            } else if (existing.status === TransactionStatus.APPROVED) {
                // Another webhook instance is currently processing - let that one finish
                this.logger.log(
                    `Payment ${reference} currently being processed by another instance`,
                );
            } else if (existing.status === TransactionStatus.FAILED) {
                const provider = this.getBuyPaymentProvider(
                    existing.paymentMethod,
                );
                const receivedAmount =
                    this.buildManualRefundAlertAmount(existing);

                // Payment was cancelled but funds still arrived — needs manual refund
                this.logger.error(
                    `Payment ${reference} was cancelled/failed but received funds — manual refund required`,
                );
                await this.slackWebhookService.sendWebhookFailureAlert(
                    provider,
                    reference,
                    "Payment received for a cancelled/failed order. Manual refund required.",
                    {
                        paymentId: existing.id,
                        orderId: existing.orderId,
                        userId: existing.userId,
                        amount: receivedAmount,
                        expectedAmount: Number(existing.totalAmount),
                        receivedAmount,
                        status: existing.status,
                        senderAccountNumber: existing.senderAccountNumber,
                        senderAccountName: existing.senderAccountName,
                        senderBankName: existing.senderBankName,
                        externalReference: existing.externalReference,
                    },
                );
            } else {
                this.logger.log(
                    `Payment ${reference} in unexpected state: ${existing.status}`,
                );
            }
            return;
        }

        // We now "own" this fulfillment - fetch full payment data
        const payment = await this.prisma.payment.findUnique({
            where: { reference },
            include: { user: true },
        });

        if (!payment) {
            // Shouldn't happen since updateMany succeeded, but guard anyway
            this.logger.error(
                `Payment disappeared after atomic update: ${reference}`,
            );
            return;
        }

        const order = await this.prisma.order.findUnique({
            where: { id: payment.orderId },
        });

        if (!order) {
            this.logger.error(`Order not found for payment: ${payment.id}`);
            return;
        }

        // OMNIBUS VIRTUAL BALANCE SYSTEM
        // Crypto stays in the main (omnibus) wallet - we only credit the user's virtual balance (ledger)
        // No Quidax transfers needed - the platform holds all crypto in one main account
        try {
            const user = payment.user;

            this.logger.log(
                `[Omnibus] Crediting virtual balance for Order ${order.id} | User: ${user.id} | Amount: ${order.amount} ${order.currency}`,
            );

            // Credit the user's ledger (virtual balance) AND update order atomically
            // CRITICAL FIX: Previously credit happened OUTSIDE the transaction, creating a window
            // where user could get free crypto if the status update failed after credit succeeded.
            // Now both operations happen in a SINGLE atomic transaction.

            let creditResult: PairedLedgerResult;

            await this.prisma.$transaction(
                async (tx) => {
                    // Step 1: Credit user's ledger INSIDE the transaction
                    creditResult =
                        await this.ledgerService.pairedCreditInTransaction(tx, {
                            userId: payment.userId,
                            currency: order.currency.toUpperCase(),
                            amount: order.amount,
                            type: LedgerType.BUY,
                            reference: `buy:${order.transactionId}`,
                            metadata: {
                                orderId: order.id,
                                paymentReference: reference,
                                omnibus: true,
                            },
                            sweepStatus: SweepStatus.NOT_APPLICABLE,
                            createPlatformEntry: true,
                        });

                    if (!creditResult.success) {
                        throw new Error(
                            `Ledger credit failed: ${creditResult.error}`,
                        );
                    }

                    // Step 2: Mark payment as SUCCESS (same transaction)
                    await tx.payment.update({
                        where: { reference },
                        data: {
                            status: TransactionStatus.SUCCESS,
                            paymentStatus: TransactionStatus.SUCCESS,
                        },
                    });

                    // Step 3: Update Order with ledger entry link (same transaction)
                    await tx.order.update({
                        where: { id: order.id },
                        data: {
                            status: OrderStatus.completed,
                            streamlinedStatus: getStreamlinedStatus(
                                OrderStatus.completed,
                            ),
                            paymentStatus: TransactionStatus.SUCCESS,
                            fulfilled: true,
                            ledgerEntryId: creditResult.userEntry?.id,
                        },
                    });

                    // All three operations (credit, payment update, order update) are now atomic
                    // If ANY step fails, the ENTIRE transaction rolls back
                },
                {
                    maxWait: DEFAULT_TRANSACTION_MAX_WAIT_MS,
                    timeout: EXTENDED_TRANSACTION_TIMEOUT_MS,
                    isolationLevel: "Serializable", // Ensures consistency
                },
            );

            // Notifications
            this.logger.log(
                `Buy order ${order.id} fulfilled and completed successfully`,
            );

            const updatedOrder = await this.prisma.order.findUnique({
                where: { id: order.id },
            });
            if (updatedOrder) {
                this.emitTransactionUpdate(payment.userId, updatedOrder);
            }
            this.wsGateway.notifyWalletUpdate(payment.userId);

            const message = `Your buy order of ${
                order.amount
            } ${order.currency.toUpperCase()} has been completed successfully.`;
            await this.notificationDispatcher.notify({
                userId: payment.userId,
                title: "Buy order successful",
                body: message,
                category: "transaction",
                currency: order.currency,
                transactionType: OrderCategory.BUY,
                enableEmail: true,
                emailPayload: {
                    email: payment.user?.email || "",
                    transactionType: "buy",
                    transactionId: order.transactionId,
                    amount: String(order.amount),
                    currency: order.currency,
                    status: "completed",
                    date: new Date().toISOString(),
                    notice: message,
                },
                enablePush: true,
            });
        } catch (error) {
            this.logger.error(
                `Failed to fulfill buy order (Transfer/Update Error) for order ${order.id}: ${error.message}`,
                error.stack,
            );

            // Revert payment to PENDING so next webhook retry can try again
            try {
                await this.prisma.payment.update({
                    where: { reference },
                    data: {
                        status: TransactionStatus.PENDING,
                        paymentStatus: TransactionStatus.PENDING,
                    },
                });
            } catch (revertError) {
                this.logger.error(
                    `Failed to revert payment status: ${revertError.message}`,
                );
            }

            // Send Slack Alert for admin intervention
            await this.slackWebhookService.sendWebhookFailureAlert(
                "quidax",
                reference,
                error.message,
                {
                    orderId: order.id,
                    transactionId: order.transactionId,
                    amount: order.amount,
                    currency: order.currency,
                    userId: order.userId,
                    cryptoSubAccountId: payment.user.cryptoSubAccountId,
                },
            );

            // Re-throw so webhook controller returns 5xx and Nomba retries
            throw error;
        }
    }

    /**
     * Build a response for an existing order (used by idempotency check and pending order guard).
     * Calculates proper VA expiry from the payment creation time.
     */
    private buildExistingOrderResponse(existingPayment: any) {
        const expiryTime =
            existingPayment.createdAt.getTime() +
            BuyOrderService.BUY_PAYMENT_WINDOW_MS;
        const expiryAt = new Date(expiryTime).toISOString();

        // Don't return stale/near-expired VA details — force user to wait for expiry + create fresh order
        const remainingMs = expiryTime - Date.now();
        if (remainingMs < 2 * 60 * 1000) {
            throw new BadRequestException(
                "Your previous order has nearly expired. Please wait a moment and try again.",
            );
        }

        const paymentInfo = existingPayment.destinationBankAccountNumber
            ? {
                  reference: existingPayment.reference,
                  accountNumber:
                      existingPayment.destinationBankAccountNumber || "",
                  accountName: existingPayment.destinationBankAccountName || "",
                  bankName: existingPayment.destinationBankName || "",
                  bankCode: "",
                  amount: Number(existingPayment.totalAmount),
                  expiryAt,
                  ussdCode: null,
              }
            : {
                  authorization_url: existingPayment.externalReference || "",
                  reference: existingPayment.reference,
                  amount: Number(existingPayment.totalAmount),
                  expiryAt,
                  ussdCode: null,
              };

        return buildResponse({
            message: "Order already exists for this request",
            data: {
                order: existingPayment.order,
                paymentInfo,
            },
        });
    }

    private emitTransactionUpdate(userId: number, order: any) {
        this.wsGateway.notifyTransactionUpdate(userId, {
            type: "transaction_update",
            transaction: {
                id: order.id,
                transactionId: order.transactionId,
                status: order.status,
                streamlinedStatus: order.streamlinedStatus,
                orderCategory: order.orderCategory,
                amount: order.amount,
                currency: order.currency,
                createdAt: order.createdAt,
                updatedAt: order.updatedAt,
            },
        });
    }

    /**
     * Get the status of a buy order by payment reference.
     * Used as a polling fallback when WebSocket is unavailable.
     */
    async getBuyOrderStatus(reference: string, userId: number) {
        const payment = await this.prisma.payment.findFirst({
            where: { reference, userId },
            include: {
                order: true,
                refundAttempts: {
                    orderBy: { createdAt: "desc" },
                    take: 1,
                },
            },
        });

        if (!payment) {
            return buildResponse({
                message: "Payment not found",
                data: { status: "not_found" },
            });
        }

        const order = payment.order;
        const latestRefundAttempt = payment.refundAttempts?.[0];
        const orderClosed =
            order?.status === OrderStatus.cancelled
            || order?.status === OrderStatus.reversed;

        // Derive client-facing status from payment + order state.
        // Closed BUY orders should surface as cancelled immediately so the
        // active payment UI can stop countdown/polling even while refund
        // settlement continues in the background.
        let status: string;
        if (payment.status === TransactionStatus.SUCCESS) {
            status = "completed";
        } else if (latestRefundAttempt?.status === TransactionStatus.SUCCESS) {
            status = "refunded";
        } else if (orderClosed) {
            status = "cancelled";
        } else if (payment.status === TransactionStatus.APPROVED) {
            status = "processing";
        } else if (payment.status === TransactionStatus.FAILED) {
            status = "failed";
        } else {
            status = "pending";
        }

        return buildResponse({
            message: "Buy order status retrieved",
            data: {
                status,
                paymentStatus: payment.paymentStatus ?? payment.status,
                processingStatus: payment.status,
                refundStatus: latestRefundAttempt?.status || null,
                refundReference: latestRefundAttempt?.reference || null,
                refundSettledAt: latestRefundAttempt?.settledAt || null,
                orderStatus: order?.status,
                orderId: order?.id,
                transactionId: order?.transactionId,
            },
        });
    }

    /**
     * Cancel a pending buy order.
     * Only cancels if payment is still PENDING (no money received yet).
     */
    async cancelBuyOrder(reference: string, userId: number) {
        const payment = await this.prisma.payment.findFirst({
            where: { reference, userId, status: TransactionStatus.PENDING },
            include: { order: true, user: true },
        });

        if (!payment) {
            return buildResponse({
                message: "No pending payment found for this reference",
                data: { cancelled: false },
            });
        }

        // Atomic cancel: only cancel if payment is still PENDING.
        // Prevents race condition where webhook claims PENDING→APPROVED between
        // the findFirst above and this update.
        const cancelled = await this.prisma.$transaction(async (tx) => {
            const updated = await tx.payment.updateMany({
                where: { id: payment.id, status: TransactionStatus.PENDING },
                data: {
                    status: TransactionStatus.FAILED,
                    paymentStatus: TransactionStatus.FAILED,
                    narration: BuyOrderService.USER_CANCEL_REASON,
                },
            });

            if (updated.count === 0) {
                // Webhook claimed the payment between findFirst and now — abort cancel
                this.logger.warn(
                    `Cancel aborted: payment ${payment.id} no longer PENDING (webhook likely claimed it)`,
                );
                return false;
            }

            if (payment.orderId) {
                await tx.order.update({
                    where: { id: payment.orderId },
                    data: {
                        status: OrderStatus.cancelled,
                        streamlinedStatus: getStreamlinedStatus(
                            OrderStatus.cancelled,
                        ),
                        paymentStatus: TransactionStatus.FAILED,
                        reason: BuyOrderService.USER_CANCEL_REASON,
                    },
                });
            }

            return true;
        });

        if (!cancelled) {
            return buildResponse({
                message:
                    "Order is already being processed and cannot be cancelled",
                data: { cancelled: false },
            });
        }

        await this.releaseReservedBuyLimit(payment);

        // Emit updates
        if (payment.order) {
            const updatedOrder = await this.prisma.order.findUnique({
                where: { id: payment.orderId },
            });
            if (updatedOrder) {
                this.emitTransactionUpdate(userId, updatedOrder);
            }
        }
        this.wsGateway.notifyWalletUpdate(userId);

        // Send cancellation notification (push + email)
        if (payment.order) {
            const message = `Your buy order of ${payment.order.amount} ${payment.order.currency.toUpperCase()} was cancelled. Transaction ID: ${payment.order.transactionId}.`;
            await this.notificationDispatcher.notify({
                userId: userId,
                title: "Buy order cancelled",
                body: `\uD83D\uDEAB ${message}`,
                category: "transaction",
                currency: payment.order.currency,
                transactionType: OrderCategory.BUY,
                enableEmail: true,
                emailPayload: {
                    email: payment.user?.email || "",
                    transactionType: "buy",
                    transactionId: payment.order.transactionId,
                    amount: String(payment.order.amount),
                    currency: payment.order.currency.toUpperCase(),
                    status: "cancelled",
                    date: new Date().toISOString(),
                    notice: message,
                },
                enablePush: true,
            });
        }

        // Best-effort: release provider-side pending payment artifacts when applicable.
        await this.inboundFiatPaymentService
            .cleanupPendingPayment({
                provider: this.getBuyPaymentProvider(payment.paymentMethod),
                reference:
                    payment.providerAccountReference || payment.reference,
            })
            .catch(() => {});

        this.logger.log(
            `Buy order cancelled by user ${userId} | Payment ref: ${reference}`,
        );

        return buildResponse({
            message: "Buy order cancelled successfully",
            data: { cancelled: true },
        });
    }

    /**
     * Send a "still pending" notification when user closes the payment modal
     * without cancelling. The order stays active.
     */
    async notifyPendingBuyOrder(reference: string, userId: number) {
        const payment = await this.prisma.payment.findFirst({
            where: { reference, userId, status: TransactionStatus.PENDING },
            include: { order: true },
        });

        if (!payment?.order) {
            return buildResponse({
                message: "No pending payment found",
                data: {},
            });
        }

        await this.notificationDispatcher.notify({
            userId,
            title: "Buy order still pending",
            body: `\u23F3 Your buy order of ${payment.order.amount} ${payment.order.currency.toUpperCase()} is still pending payment. Complete the bank transfer before the account expires. Transaction ID: ${payment.order.transactionId}.`,
            category: "transaction",
            currency: payment.order.currency,
            transactionType: OrderCategory.BUY,
            enablePush: true,
        });

        this.logger.log(
            `Pending buy order reminder sent to user ${userId} | Payment ref: ${reference}`,
        );

        return buildResponse({
            message: "Pending reminder sent",
            data: {},
        });
    }

    /**
     * Record that the user clicked "I've sent the money".
     * Sets a timestamp so the stuck-order detector can alert admins
     * if the Nomba webhook doesn't arrive within a reasonable window.
     */
    async confirmPaymentSent(reference: string, userId: number) {
        const payment = await this.prisma.payment.findFirst({
            where: {
                reference,
                userId,
                status: {
                    in: [TransactionStatus.PENDING, TransactionStatus.APPROVED],
                },
            },
            include: { order: true },
        });

        if (!payment) {
            return buildResponse({
                message: "No active payment found for this reference",
                data: { confirmed: false },
            });
        }

        // Only set once — ignore duplicate clicks
        if (!payment.paymentConfirmedByUser) {
            await this.prisma.payment.update({
                where: { id: payment.id },
                data: { paymentConfirmedByUser: new Date() },
            });

            this.logger.log(
                `User ${userId} confirmed payment sent | Ref: ${reference} | Order: ${payment.orderId}`,
            );
        }

        return buildResponse({
            message: "Payment confirmation recorded",
            data: { confirmed: true },
        });
    }

    /**
     * Detect buy orders where user confirmed payment but webhook hasn't arrived.
     * Called by a scheduled cron job.
     * Sends Slack alerts for admin intervention.
     */
    async detectStuckConfirmedOrders() {
        const stuckPayments = await this.prisma.payment.findMany({
            where: {
                status: TransactionStatus.PENDING,
                paymentMethod: { in: this.getSupportedBuyPaymentMethods() },
                type: TransactionType.P2P_PAYMENT,
                orderId: { not: null },
                // Only alert payments we haven't already alerted
                stuckAlertSentAt: null,
                paymentConfirmedByUser: {
                    not: null,
                    // User confirmed over 5 minutes ago but webhook never arrived
                    lt: new Date(Date.now() - 5 * 60 * 1000),
                },
            },
            include: {
                order: true,
                user: {
                    select: {
                        id: true,
                        email: true,
                        firstName: true,
                        lastName: true,
                    },
                },
            },
        });

        if (stuckPayments.length === 0) return 0;

        this.logger.warn(
            `Found ${stuckPayments.length} stuck buy orders where user confirmed payment but webhook didn't arrive`,
        );

        for (const payment of stuckPayments) {
            try {
                const provider = this.getBuyPaymentProvider(
                    payment.paymentMethod,
                );
                const providerLabel = this.getBuyPaymentProviderLabel(
                    payment.paymentMethod,
                );

                await this.slackWebhookService.sendWebhookFailureAlert(
                    provider,
                    payment.reference,
                    `User confirmed payment sent but ${providerLabel} webhook never arrived. Manual verification required.`,
                    {
                        orderId: payment.orderId,
                        transactionId: payment.order?.transactionId,
                        amount: payment.order?.amount,
                        currency: payment.order?.currency,
                        userId: payment.userId,
                        userEmail: payment.user?.email,
                        userName: `${payment.user?.firstName} ${payment.user?.lastName}`,
                        confirmedAt:
                            payment.paymentConfirmedByUser?.toISOString(),
                        paymentCreatedAt: payment.createdAt.toISOString(),
                    },
                );

                // Mark as alerted so we don't spam Slack on subsequent cron runs
                await this.prisma.payment.update({
                    where: { id: payment.id },
                    data: { stuckAlertSentAt: new Date() },
                });

                this.logger.warn(
                    `Slack alert sent for stuck order | Payment: ${payment.id} | Ref: ${payment.reference} | User: ${payment.userId}`,
                );
            } catch (error) {
                this.logger.error(
                    `Failed to send Slack alert for stuck payment ${payment.id}: ${error.message}`,
                );
            }
        }

        return stuckPayments.length;
    }

    /**
     * Cancel expired buy orders.
     * Called by a scheduled job to clean up orders whose virtual account expired
     * without receiving payment.
    * NOTE: Excludes orders where user confirmed they sent payment or where
    * a wrong amount was already received — those are handled by the BUY
    * wrong-amount refund flow and expiry-close reconciliation instead.
     */
    async cancelExpiredBuyOrders() {
        const expiredPayments = await this.prisma.payment.findMany({
            where: {
                status: TransactionStatus.PENDING,
                paymentMethod: { in: this.getSupportedBuyPaymentMethods() },
                type: TransactionType.P2P_PAYMENT,
                orderId: { not: null },
                // Don't auto-cancel orders where user confirmed payment — admin must review
                paymentConfirmedByUser: null,
                // Don't auto-cancel underpaid orders that already need the 2-hour refund path
                receivedAmount: null,
                // Orders older than 35 minutes (5 min buffer beyond 30 min VA expiry)
                createdAt: {
                    lt: new Date(
                        Date.now() - BuyOrderService.BUY_PAYMENT_WINDOW_MS,
                    ),
                },
            },
            include: {
                order: true,
                user: { select: { id: true, email: true } },
            },
        });

        this.logger.log(
            `Found ${expiredPayments.length} expired buy order payments to cancel`,
        );

        for (const payment of expiredPayments) {
            try {
                // Atomic: only cancel if still PENDING — prevents race with late webhook
                const didCancel = await this.prisma.$transaction(async (tx) => {
                    const updated = await tx.payment.updateMany({
                        where: {
                            id: payment.id,
                            status: TransactionStatus.PENDING,
                        },
                        data: {
                            status: TransactionStatus.FAILED,
                            paymentStatus: TransactionStatus.FAILED,
                            narration: BuyOrderService.EXPIRED_CANCEL_REASON,
                        },
                    });

                    if (updated.count === 0) {
                        this.logger.warn(
                            `Skipping expired cancel for payment ${payment.id} — no longer PENDING`,
                        );
                        return false;
                    }

                    if (payment.orderId) {
                        await tx.order.update({
                            where: { id: payment.orderId },
                            data: {
                                status: OrderStatus.cancelled,
                                streamlinedStatus: getStreamlinedStatus(
                                    OrderStatus.cancelled,
                                ),
                                paymentStatus: TransactionStatus.FAILED,
                                reason: BuyOrderService.EXPIRED_CANCEL_REASON,
                            },
                        });
                    }

                    return true;
                });

                if (!didCancel) continue;

                await this.releaseReservedBuyLimit(payment);

                // Emit updates
                if (payment.order) {
                    this.emitTransactionUpdate(payment.userId, {
                        ...payment.order,
                        status: OrderStatus.cancelled,
                        streamlinedStatus: getStreamlinedStatus(
                            OrderStatus.cancelled,
                        ),
                    });
                }
                this.wsGateway.notifyWalletUpdate(payment.userId);

                // Send expired cancellation notification (push + email - user may not be in app)
                if (payment.order) {
                    const expiredMessage = `Your buy order of ${payment.order.amount} ${payment.order.currency.toUpperCase()} was cancelled because the payment window expired. Transaction ID: ${payment.order.transactionId}.`;
                    await this.notificationDispatcher.notify({
                        userId: payment.userId,
                        title: "Buy order expired",
                        body: `\uD83D\uDEAB ${expiredMessage}`,
                        category: "transaction",
                        currency: payment.order.currency,
                        transactionType: OrderCategory.BUY,
                        enableEmail: true,
                        emailPayload: {
                            email: payment.user?.email || "",
                            transactionType: "buy",
                            transactionId: payment.order.transactionId,
                            amount: String(payment.order.amount),
                            currency: payment.order.currency.toUpperCase(),
                            status: "cancelled",
                            date: new Date().toISOString(),
                            notice: expiredMessage,
                        },
                        enablePush: true,
                    });
                }

                // Best-effort: release provider-side pending payment artifacts when applicable.
                await this.inboundFiatPaymentService
                    .cleanupPendingPayment({
                        provider: this.getBuyPaymentProvider(
                            payment.paymentMethod,
                        ),
                        reference:
                            payment.providerAccountReference ||
                            payment.reference,
                    })
                    .catch(() => {});

                this.logger.log(
                    `Cancelled expired buy order | Payment: ${payment.id} | Ref: ${payment.reference}`,
                );
            } catch (error) {
                this.logger.error(
                    `Failed to cancel expired payment ${payment.id}: ${error.message}`,
                );
            }
        }

        return expiredPayments.length;
    }

    private async handleExpiredWrongAmountOrderClosure(options: {
        payment: any;
        provider: InboundPaymentProvider;
        expectedAmount: number;
        receivedAmount: number;
        alreadyRefundFlagged: boolean;
    }): Promise<void> {
        const {
            payment,
            provider,
            expectedAmount,
            receivedAmount,
            alreadyRefundFlagged,
        } = options;

        if (payment.order) {
            this.emitTransactionUpdate(payment.userId, {
                ...payment.order,
                status: OrderStatus.reversed,
                streamlinedStatus: getStreamlinedStatus(OrderStatus.reversed),
                updatedAt: new Date(),
            });

            const expiryMessage =
                `Your buy order ${payment.order.transactionId} expired before we received the exact required payment of ` +
                `₦${expectedAmount}. We received ₦${receivedAmount} instead. The order is now closed.`;

            await this.buyRefundOrchestratorService.ensureRefundPayoutForPayment({
                paymentId: payment.id,
                provider,
                reasonCode: BUY_REFUND_REASON.ACTIVE_WRONG_AMOUNT,
                refundAmount: receivedAmount,
                metadata: {
                    expectedAmount,
                    receivedAmount,
                    orderExpired: true,
                },
            });

            await this.notificationDispatcher.notify({
                userId: payment.userId,
                title: "Buy order expired",
                body: expiryMessage,
                category: "transaction",
                currency: payment.order.currency,
                transactionType: OrderCategory.BUY,
                enableEmail: true,
                emailPayload: {
                    email: payment.user?.email || "",
                    transactionType: "buy",
                    transactionId: payment.order.transactionId,
                    amount: String(payment.order.amount),
                    currency: payment.order.currency.toUpperCase(),
                    status: "cancelled",
                    date: new Date().toISOString(),
                    notice: expiryMessage,
                },
                enablePush: true,
            });
        }

        if (alreadyRefundFlagged) {
            return;
        }

        await this.slackWebhookService.sendWebhookFailureAlert(
            provider,
            payment.reference,
            `Wrong-amount BUY payment expired without an exact resend. Order closed as refunded.`,
            {
                orderId: payment.orderId,
                userId: payment.userId,
                expectedAmount,
                receivedAmount,
                senderAccountNumber: payment.senderAccountNumber,
                senderAccountName: payment.senderAccountName,
                senderBankName: payment.senderBankName,
            },
        );
    }

    private async handleExpiredAccountNameMismatchOrderClosure(options: {
        payment: any;
        provider: InboundPaymentProvider;
        expectedAmount: number;
        receivedAmount: number;
        alreadyRefundFlagged: boolean;
    }): Promise<void> {
        const {
            payment,
            provider,
            expectedAmount,
            receivedAmount,
            alreadyRefundFlagged,
        } = options;
        const registeredAccountName = this.buildRegisteredBuyAccountName(
            payment.user,
        );
        const senderAccountName = payment.senderAccountName?.trim() || null;

        if (payment.order) {
            this.emitTransactionUpdate(payment.userId, {
                ...payment.order,
                status: OrderStatus.reversed,
                streamlinedStatus: getStreamlinedStatus(OrderStatus.reversed),
                updatedAt: new Date(),
            });

            const registeredDescriptor = registeredAccountName
                ? `your registered account holder name ${registeredAccountName}`
                : "your registered account holder name";
            const senderDescriptor = senderAccountName
                ? `from ${senderAccountName}`
                : "from the sender account we received";
            const expiryMessage =
                `Your buy order ${payment.order.transactionId} expired before we received a valid matching payment for the exact required ` +
                `₦${expectedAmount}. We received the exact amount ${senderDescriptor}, but it did not sufficiently match ${registeredDescriptor}. ` +
                `The order is now closed.`;

            await this.buyRefundOrchestratorService.ensureRefundPayoutForPayment({
                paymentId: payment.id,
                provider,
                reasonCode: BUY_REFUND_REASON.ACCOUNT_NAME_MISMATCH,
                refundAmount: receivedAmount,
                metadata: {
                    expectedAmount,
                    receivedAmount,
                    orderExpired: true,
                    registeredAccountName,
                    senderAccountName,
                },
            });

            await this.notificationDispatcher.notify({
                userId: payment.userId,
                title: "Buy order expired",
                body: expiryMessage,
                category: "transaction",
                currency: payment.order.currency,
                transactionType: OrderCategory.BUY,
                enableEmail: true,
                emailPayload: {
                    email: payment.user?.email || "",
                    transactionType: "buy",
                    transactionId: payment.order.transactionId,
                    amount: String(payment.order.amount),
                    currency: payment.order.currency.toUpperCase(),
                    status: "cancelled",
                    date: new Date().toISOString(),
                    notice: expiryMessage,
                },
                enablePush: true,
            });
        }

        if (alreadyRefundFlagged) {
            return;
        }

        await this.slackWebhookService.sendWebhookFailureAlert(
            provider,
            payment.reference,
            "Account-name mismatch BUY payment expired without a valid matching resend. Order closed as refunded.",
            {
                orderId: payment.orderId,
                userId: payment.userId,
                expectedAmount,
                receivedAmount,
                registeredAccountName,
                senderAccountName,
                senderAccountNumber: payment.senderAccountNumber,
                senderBankName: payment.senderBankName,
            },
        );
    }

    /**
     * Legacy method name kept for scheduler compatibility.
     * Closes expired BUY orders where an invalid fiat payment was received while
     * the order was still active. Wrong amounts and exact-amount account-name
     * mismatches are flagged for refund by the webhook path immediately; when the
     * payment window expires without a valid resend, this closes the order as
     * reversed/refunded.
     */
    async cancelUnderpaidBuyOrders() {
        const invalidPayments = await this.prisma.payment.findMany({
            where: {
                paymentMethod: { in: this.getSupportedBuyPaymentMethods() },
                orderId: { not: null },
                receivedAmount: { not: null },
                status: TransactionStatus.PENDING,
                // Close the order once the original BUY payment window has expired
                createdAt: {
                    lt: new Date(
                        Date.now() - BuyOrderService.BUY_PAYMENT_WINDOW_MS,
                    ),
                },
            },
            include: {
                order: true,
                user: {
                    select: {
                        id: true,
                        email: true,
                        firstName: true,
                        lastName: true,
                        middleName: true,
                        businessName: true,
                        userType: true,
                    },
                },
                refundAttempts: {
                    where: {
                        reasonCode: {
                            in: [
                                ...BuyOrderService.ACTIVE_INVALID_BUY_REFUND_REASONS,
                            ],
                        },
                    },
                    orderBy: { createdAt: "desc" },
                },
            },
        });

        // Filter to orders that are still open with an invalid received payment.
        const toCancel = invalidPayments.filter((p) => {
            const expected = Number(p.totalAmount);
            const received = Number(p.receivedAmount);

            if (
                !Number.isFinite(expected)
                || expected <= 0
                || !Number.isFinite(received)
                || p.order?.status !== OrderStatus.pending
            ) {
                return false;
            }

            if (!this.numbersMatchWithinKobo(received, expected)) {
                return true;
            }

            return (
                Boolean(
                    this.getLatestActiveInvalidRefundAttemptForReason(
                        p.refundAttempts,
                        BUY_REFUND_REASON.ACCOUNT_NAME_MISMATCH,
                    ),
                )
            );
        });

        this.logger.log(
            `Found ${toCancel.length} expired invalid-payment buy orders to close`,
        );

        for (const payment of toCancel) {
            try {
                const provider = this.getBuyPaymentProvider(
                    payment.paymentMethod,
                );
                const alreadyRefundFlagged =
                    payment.paymentStatus === TransactionStatus.REVERSAL;
                const expected = Number(payment.totalAmount);
                const received = Number(payment.receivedAmount);
                const isExpiredAccountNameMismatch =
                    this.numbersMatchWithinKobo(received, expected)
                    && Boolean(
                        this.getLatestActiveInvalidRefundAttemptForReason(
                            payment.refundAttempts,
                            BUY_REFUND_REASON.ACCOUNT_NAME_MISMATCH,
                        ),
                    );
                const narration = isExpiredAccountNameMismatch
                    ? this.buildExpiredAccountNameMismatchNarration(
                          received,
                          expected,
                          payment.senderAccountName || null,
                          this.buildRegisteredBuyAccountName(payment.user),
                      )
                    : this.buildLatePaymentRefundNarration(
                          received,
                          expected,
                      );

                const didCancel = await this.prisma.$transaction(async (tx) => {
                    const updated = await tx.payment.updateMany({
                        where: {
                            id: payment.id,
                            status: TransactionStatus.PENDING,
                        },
                        data: {
                            status: TransactionStatus.REVERSAL,
                            paymentStatus: TransactionStatus.REVERSAL,
                            narration,
                        },
                    });

                    if (updated.count === 0) return false;

                    if (payment.orderId) {
                        await tx.order.update({
                            where: { id: payment.orderId },
                            data: {
                                status: OrderStatus.reversed,
                                streamlinedStatus: getStreamlinedStatus(
                                    OrderStatus.reversed,
                                ),
                                paymentStatus: TransactionStatus.REVERSAL,
                                reason: narration,
                            },
                        });
                    }

                    return true;
                });

                if (!didCancel) continue;

                await this.releaseReservedBuyLimit(payment);

                if (isExpiredAccountNameMismatch) {
                    await this.handleExpiredAccountNameMismatchOrderClosure({
                        payment,
                        provider,
                        expectedAmount: expected,
                        receivedAmount: received,
                        alreadyRefundFlagged,
                    });

                    this.logger.log(
                        `Closed expired account-name mismatch buy order | Payment: ${payment.id} | Ref: ${payment.reference}`,
                    );
                    continue;
                }

                await this.handleExpiredWrongAmountOrderClosure({
                    payment,
                    provider,
                    expectedAmount: expected,
                    receivedAmount: received,
                    alreadyRefundFlagged,
                });

                this.logger.log(
                    `Closed expired wrong-amount buy order | Payment: ${payment.id} | Ref: ${payment.reference}`,
                );
            } catch (error) {
                this.logger.error(
                    `Failed to close expired wrong-amount payment ${payment.id}: ${error.message}`,
                );
            }
        }

        return toCancel.length;
    }
    /**
     * Executes the Internal Buy Leg of a Swap (Admin -> User)
     * Does NOT create a DB Order (SwapService handles that).
     *
     * OMNIBUS VIRTUAL BALANCE: Only credits the target currency to user's ledger
     * No actual crypto transfer happens - crypto stays in omnibus wallet
     */
    async executeInternalBuy(
        user: User,
        amount: number, // Amount of Crypto B to credit to user's virtual balance
        currency: string,
        reference: string,
    ) {
        this.logger.log(
            `[Omnibus] Executing Internal Buy for Swap | User: ${user.id} | Amount: ${amount} ${currency} | Ref: ${reference}`,
        );

        // OMNIBUS: Credit the target currency to user's ledger (virtual balance)
        // No Quidax transfer needed - crypto stays in main omnibus wallet
        // DOUBLE ENTRY: pairedCredit ensures platform liability (debit) is created
        const creditResult = await this.ledgerService.pairedCredit({
            userId: user.id,
            currency: currency.toUpperCase(),
            amount,
            type: LedgerType.SWAP_IN,
            reference: `swap-buy:${reference}`,
            metadata: {
                swapReference: reference,
                omnibus: true, // Flag indicating this is omnibus (no Quidax transfer)
            },
            sweepStatus: SweepStatus.NOT_APPLICABLE, // Swap buy doesn't need sweep - funds stay in omnibus
            createPlatformEntry: true,
        });

        if (!creditResult.success) {
            this.logger.error(
                `Failed to credit ledger for swap buy leg: ${creditResult.error}`,
            );
            throw new Error(`Ledger credit failed: ${creditResult.error}`);
        }

        // Return a success result (matches the interface callers expect)
        return {
            status: "success",
            data: {
                id: creditResult.userEntry?.id,
                amount,
                currency: currency.toUpperCase(),
            },
        };
    }
}
