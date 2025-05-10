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
