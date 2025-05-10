export * from "./virtualAccount";
export * from "./bank";
export * from "./transaction";
export * from "./transfer";
export * from "./virtualAccount";

export interface PaystackOptions {
    baseUrl: string;
    secretKey: string;
    callback_url?: string;
    cancel_action?: string;
}

export type PaystackPaymentChannel =
    | "card"
    | "bank"
    | "ussd"
    | "qr"
    | "mobile_money"
    | "bank_transfer"
    | "dedicated_nuban";

export interface PaystackResponse<D = undefined> {
    status: boolean;
    message: string;
    data: D;
}
