export interface NormalizedPaymentEvent {
    provider: 'nomba' | 'fincra';
    type: 'payment_success' | 'payout_success' | 'payment_failed' | 'payout_failed' | 'other';
    reference: string;      // Best-match reference extracted from the provider payload
    providerReference?: string; // The provider's internal transaction ID
    amount?: number;
    currency?: string;
    senderAccountNumber?: string;
    senderAccountName?: string;
    senderBankName?: string;
    raw: any; // Keep raw payload for logging/debugging
    metadata?: {
        accountRef?: string;
        customerEmail?: string;
        fee?: number;
    };
}
