import { TransactionStatus } from "@prisma/client";

import { BuyOrderService } from "@/modules/api/trade/services/buy-order.service";

import { NormalizedPaymentEvent } from "../types/payment-event.interface";

export type BuyOrderWebhookPayment = {
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
};

type HandleBuyOrderWebhookPaymentOptions = {
    payment: BuyOrderWebhookPayment;
    event: NormalizedPaymentEvent;
    reference: string;
    provider: "fincra" | "nomba";
    buyOrderService: BuyOrderService;
};

export async function handleBuyOrderWebhookPayment({
    payment,
    event,
    reference,
    provider,
    buyOrderService,
}: HandleBuyOrderWebhookPaymentOptions): Promise<void> {
    await buyOrderService.handleWebhookBuyOrderPayment({
        payment,
        event,
        reference,
        provider,
    });
}