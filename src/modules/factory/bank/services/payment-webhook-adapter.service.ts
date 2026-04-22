import { Injectable } from "@nestjs/common";

import { PaymentWebhookSourceEventName } from "@/modules/api/banks/dtos/payment-webhook.dto";
import { NormalizedPaymentEvent } from "@/modules/api/banks/types/payment-event.interface";
import { FincraWebhookPayload } from "@/modules/webhook/fincra/interfaces";

type WebhookEventStatus = NormalizedPaymentEvent["status"];
type WebhookEventKind = NormalizedPaymentEvent["kind"];

@Injectable()
export class PaymentWebhookAdapterService {
    normalizeNombaWebhook(body: any): NormalizedPaymentEvent {
        const eventName = String(body?.event_type || body?.event || "other");
        const outerData = body?.data || {};
        const data = (outerData.data && (outerData.data.transaction || outerData.data.merchant))
            ? outerData.data
            : outerData;
        const transaction = data.transaction || {};
        const order = data.order || {};
        const customer = data.customer || {};

        const reference = transaction.aliasAccountReference
            || data.accountRef
            || transaction.accountRef
            || order.orderReference
            || data.reference
            || transaction.reference
            || transaction.merchantTxRef;

        const isWalletTopup = transaction.type === "wallet_topup";
        const amount = Number(data.amount || transaction.transactionAmount || order.amount || 0) || undefined;

        let kind: WebhookEventKind = "other";
        let status: WebhookEventStatus = "other";

        switch (eventName) {
            case "payment_success":
            case "order_success":
            case PaymentWebhookSourceEventName.TRANSACTION_COMPLETED:
            case PaymentWebhookSourceEventName.VIRTUAL_ACCOUNT_CREDITED:
                if (!(isWalletTopup && !reference)) {
                    kind = "incoming_payment";
                    status = "successful";
                }
                break;
            case "payout_success":
            case PaymentWebhookSourceEventName.TRANSFER_SUCCESSFUL:
                kind = "payout";
                status = "successful";
                break;
            case "payment_failed":
                kind = "incoming_payment";
                status = "failed";
                break;
            case "payout_failed":
            case PaymentWebhookSourceEventName.TRANSFER_FAILED:
                kind = "payout";
                status = "failed";
                break;
            default:
                break;
        }

        return {
            provider: "nomba",
            eventName,
            kind,
            status,
            reference,
            providerReference: transaction.transactionId || data.id,
            amount,
            currency: "NGN",
            senderAccountNumber: customer.accountNumber,
            senderAccountName: customer.senderName,
            senderBankName: customer.bankName,
            raw: body,
            metadata: {
                accountRef: data.accountRef || transaction.accountRef || transaction.aliasAccountReference || order.accountId,
                customerEmail: data.customerEmail || order.customerEmail,
            },
        };
    }

    normalizeFincraWebhook(payload: FincraWebhookPayload | Record<string, any>): NormalizedPaymentEvent {
        const eventName = String(payload?.event || "other").toLowerCase();
        const data = (payload?.data || {}) as Record<string, any>;
        const reference = data.customerReference || data.merchantReference || data.reference;
        const kind = this.resolveFincraKind(eventName);
        const status = this.resolveFincraStatus(eventName, data.status);

        return {
            provider: "fincra",
            eventName,
            kind,
            status,
            reference,
            providerReference: data.reference || data.id,
            amount: (() => {
                if (typeof data.amountReceived === "number") {
                    return data.amountReceived;
                }

                if (typeof data.amount === "number") {
                    return data.amount;
                }

                const normalizedAmount = Number(data.amountReceived || data.amount || 0);
                return normalizedAmount || undefined;
            })(),
            currency: data.currency || "NGN",
            senderAccountNumber: data.accountNumber,
            senderAccountName: data.accountName || data.accountHolderName,
            senderBankName: data.bankName,
            raw: payload,
            metadata: {
                fee: typeof data.fee === "number" ? data.fee : Number(data.fee || 0) || undefined,
            },
        };
    }

    private resolveFincraKind(eventName: string): WebhookEventKind {
        if (eventName.includes("payout") || eventName.includes("disbursement")) {
            return "payout";
        }

        if (eventName.includes("collection") || eventName.includes("charge")) {
            return "incoming_payment";
        }

        return "other";
    }

    private resolveFincraStatus(eventName: string, status?: string): WebhookEventStatus {
        const normalizedStatus = String(status || "").toLowerCase();

        if (normalizedStatus === "success" || normalizedStatus === "successful") {
            return "successful";
        }

        if (normalizedStatus === "failed" || normalizedStatus === "cancelled") {
            return "failed";
        }

        if (normalizedStatus === "pending" || normalizedStatus === "processing") {
            return "pending";
        }

        if (eventName.endsWith("successful") || eventName.endsWith("success")) {
            return "successful";
        }

        if (eventName.endsWith("failed") || eventName.endsWith("cancelled")) {
            return "failed";
        }

        if (eventName.endsWith("pending") || eventName.endsWith("processing")) {
            return "pending";
        }

        return "other";
    }
}