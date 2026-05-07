import * as b from "./base";

export type BankInfo = b.BankInfo;

export interface ConfigOptions {
    merchantName: string;
}

export interface UserRecord {
    id: number;
    firstName: string;
    lastName: string;
    email: string;
    phoneNumber?: string;
}

export type FincraInitiationResponseResultType = {
    link: string;
    reference: string;
    payCode: string;
};

// Bank list response type
export interface FincraBankListItem {
    name: string;
    code: string;
    country: string;
}

// Resolve account options and response
export interface ResolveBankAccountOptions {
    account_number: string;
    bank_code: string;
}

export interface ResolveBankAccountResponse {
    accountNumber: string;
    accountName: string;
    bankCode: string;
}

// Transfer options
export interface InitializeTransferOptions {
    amount: number;
    accountName: string;
    accountNumber: string;
    bankCode: string;
    bankName: string;
    userId: number;
    reference: string;
    serviceCharge: number;
    orderId?: number;
    senderName?: string;
    senderEmail?: string;
}

export interface InitializeRefundTransferOptions {
    amount: number;
    accountName?: string | null;
    accountNumber: string;
    bankCode: string;
    bankName?: string | null;
    userId: number;
    orderId: number;
    refundAttemptId: number;
    reference: string;
    senderName?: string;
    senderEmail?: string;
    narration?: string;
}

// Interface for the FincraBank provider
export interface IFincraBank {
    name?: string;
}
