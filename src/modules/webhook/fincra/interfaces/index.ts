export interface FincraWebhookPayload {
    event: string; // e.g. charge.successful, payout.successful
    data: FincraChargeData | FincraPayoutData;
}

export interface FincraChargeData {
    amount: number;
    amountReceived?: number;
    currency: string;
    fee?: number;
    message?: string;
    status: string; // success, failed, pending
    reference: string;
    merchantReference?: string;
    description?: string;
    type?: string;
}

export interface FincraPayoutData {
    id: string;
    reference: string;
    customerReference: string;
    status: string; // processing, successful, failed, pending
    amount: number;
    fee: number;
    currency: string;
    description?: string;
    beneficiary?: {
        accountNumber: string;
        bankCode: string;
        accountHolderName: string;
    };
}
