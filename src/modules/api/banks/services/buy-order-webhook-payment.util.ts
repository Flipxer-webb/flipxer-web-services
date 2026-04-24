import { TransactionStatus } from "@prisma/client";

import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { BuyOrderService } from "@/modules/api/trade/services/buy-order.service";
import { PrismaService } from "@/modules/core/prisma/services";

import { NormalizedPaymentEvent } from "../types/payment-event.interface";

const UNDERPAYMENT_THRESHOLD_RATIO = 0.99;

export type BuyOrderWebhookPayment = {
    id: number;
    orderId: number;
    userId: number;
    totalAmount: unknown;
    reference: string;
    status?: TransactionStatus | null;
};

type WebhookLogger = {
    warn(message: string): void;
};

type UnderpaymentMessageBuilder = (context: {
    amount: number;
    expectedAmount: number;
    event: NormalizedPaymentEvent;
    payment: BuyOrderWebhookPayment;
    reference: string;
}) => string;

type HandleBuyOrderWebhookPaymentOptions = {
    payment: BuyOrderWebhookPayment;
    event: NormalizedPaymentEvent;
    reference: string;
    provider: "fincra" | "nomba";
    prisma: PrismaService;
    buyOrderService: BuyOrderService;
    slackWebhookService: SlackWebhookService;
    logger?: WebhookLogger;
    buildUnderpaymentMessage?: UnderpaymentMessageBuilder;
};

function isPositiveNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isUnderpaid(amount: unknown, expectedAmount: number): amount is number {
    return isPositiveNumber(amount) && expectedAmount > 0 && amount < expectedAmount * UNDERPAYMENT_THRESHOLD_RATIO;
}

function buildPaymentUpdateData(event: NormalizedPaymentEvent, expectedAmount: number) {
    const paymentUpdateData: Record<string, unknown> = {};

    if (isPositiveNumber(event.amount)) {
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
    if (event.providerReference) {
        paymentUpdateData.externalReference = event.providerReference;
    }

    if (isUnderpaid(event.amount, expectedAmount)) {
        paymentUpdateData.narration = `Underpayment: received ₦${event.amount} of expected ₦${expectedAmount}`;
    }

    return paymentUpdateData;
}

function defaultUnderpaymentMessage(amount: number, expectedAmount: number): string {
    return `Underpayment: received ${amount} but expected ${expectedAmount}. Order NOT auto-fulfilled. Auto-cancel will run after 2 hours. Ops must process refund.`;
}

export async function handleBuyOrderWebhookPayment({
    payment,
    event,
    reference,
    provider,
    prisma,
    buyOrderService,
    slackWebhookService,
    logger,
    buildUnderpaymentMessage,
}: HandleBuyOrderWebhookPaymentOptions): Promise<void> {
    const expectedAmount = Number(payment.totalAmount);
    const paymentUpdateData = buildPaymentUpdateData(event, expectedAmount);

    if (Object.keys(paymentUpdateData).length > 0) {
        await prisma.payment.update({
            where: { id: payment.id },
            data: paymentUpdateData,
        });
    }

    if (payment.status === TransactionStatus.FAILED) {
        logger?.warn(
            `Payment ${reference} already cancelled/failed before webhook processing. Triggering manual refund alert.`
        );
        await buyOrderService.fulfillBuyOrder(reference);
        return;
    }

    if (isUnderpaid(event.amount, expectedAmount)) {
        const amount = event.amount;
        await slackWebhookService.sendWebhookFailureAlert(
            provider,
            reference,
            buildUnderpaymentMessage?.({
                amount,
                expectedAmount,
                event,
                payment,
                reference,
            }) ?? defaultUnderpaymentMessage(amount, expectedAmount),
            {
                orderId: payment.orderId,
                userId: payment.userId,
                expectedAmount,
                receivedAmount: amount,
                shortfall: expectedAmount - amount,
                senderAccountNumber: event.senderAccountNumber,
                senderAccountName: event.senderAccountName,
                senderBankName: event.senderBankName,
            },
        );
        return;
    }

    await buyOrderService.fulfillBuyOrder(reference);
}