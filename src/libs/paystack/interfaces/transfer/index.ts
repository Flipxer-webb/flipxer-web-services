type Currency = "NGN" | "GHS" | "ZAR" | "All";
type Type = "nuban" | "mobile_money" | "basa" | "authorization";
type Source = "balance";

export interface TransferRecipientOptions {
    type: Type;
    name: string;
    account_number: string;
    bank_code: string;
    currency: Currency;
}

export interface TransferRecipientResponseData {
    active: boolean;
    createdAt: string;
    currency: Currency;
    domain: string;
    id: number;
    integration: number;
    name: string;
    recipient_code: string;
    type: Type;
    updatedAt: string;
    is_deleted: boolean;
    details: {
        authorization_code?: string;
        account_number: string;
        account_name?: string;
        bank_code: string;
        bank_name: string;
    };
}

export interface InitiateTransferOptions {
    source: Source;
    reason?: string;
    amount: number;
    reference: string;
    recipient: string;
}

export interface InitiateTransferResponseData {
    integration: number;
    domain: string;
    amount: string;
    currency: string;
    source: Source;
    reason: string;
    recipient: number;
    status: string;
    transfer_code: string;
    id: number;
    createdAt: string;
    updatedAt: string;
}
