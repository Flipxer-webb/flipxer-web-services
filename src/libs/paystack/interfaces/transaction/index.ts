export type VerifyTransactionStatus = "success" | "abandoned" | "failed";
export interface VerifyTransactionResponseData {
    status: VerifyTransactionStatus;
    data?: any;
}
export interface IPaystackInitializePaymentDetail {
    email: string;
    amount: number;
    callback_url?: string;
    metadata: PaystackMetadata;
}

export type PaystackMetadata = {
    user_id: number;
    callback_url?: string;
    cancel_action?: string;
    custom_fields: PaystackMetadataCustomField[];
};

export type PaystackMetadataCustomField = {
    display_name: string;
    variable_name: string;
    value: string | number;
};

export type PaystackInitializePaymentResponse = {
    status: boolean;
    message: string;
    data: { authorization_url: string; access_code: string; reference: string };
};
