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
}

export type PastackInitiationResponseResultType = {
    authorization_url: string;
    access_code: string;
    reference: string;
};

export interface InitializeTransferOptions {
    accountNumber: string;
    bankCode: string;
    amount: number;
    accountName: string;
    serviceCharge: number;
    bankName: string;
    userId: number;
    userType: string;
    reference: string;
    orderId?: number;
}
