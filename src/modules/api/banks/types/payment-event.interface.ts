import type { BankProvider } from "@/modules/factory/bank/types";

export interface NormalizedPaymentEvent {
    provider: BankProvider;
    eventName: string;
    kind: "incoming_payment" | "payout" | "other";
    status: "successful" | "failed" | "pending" | "other";
    reference?: string; // Best-match reference extracted from the provider payload
    providerReference?: string; // The provider's internal transaction ID
    amount?: number;
    currency?: string;
    senderAccountNumber?: string;
    senderAccountName?: string;
    senderBankName?: string;
    senderBankCode?: string;
    raw: any; // Keep raw payload for logging/debugging
    metadata?: {
        accountRef?: string;
        customerEmail?: string;
        fee?: number;
    };
}
