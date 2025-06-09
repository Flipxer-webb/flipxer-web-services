export interface PaystackGenericData {
    [key: string]: any;
}

export enum Channel {
    DEDICATED_NUBAN = "dedicated_nuban",
}

export enum Event {
    DedicatedAssignSuccessEvent = "dedicatedaccount.assign.success",
    CustomerIdentificationSuccessEvent = "customeridentification.success",
    ChargeSuccessEvent = "charge.success",
    TransferSuccessEvent = "transfer.success",
    TransferFailedEvent = "transfer.failed",
    TransferReversedEvent = "transfer.reversed",
}

export interface EventBody<E extends Event = Event> {
    event: E;
    data: E extends keyof EventDataMap ? EventDataMap[E] : never;
}

type EventDataMap = {
    [Event.DedicatedAssignSuccessEvent]: DedicatedAccountAssignSuccessData;
    [Event.CustomerIdentificationSuccessEvent]: CustomerIdentificationSuccessData;
    [Event.ChargeSuccessEvent]: ChargeSuccessData;
    [Event.TransferSuccessEvent]: TransferData;
    [Event.TransferFailedEvent]: TransferData;
    [Event.TransferReversedEvent]: TransferData;
};

//charge.success data (both normal and transfer)
export interface ChargeSuccessData<Meta = ChargeSuccessMetadata> {
    id: number;
    amount: number;
    domain: string;
    status: string;
    reference: string;
    channel: string;
    currency: string;
    metadata: Meta;
    customer: {
        id: number;
        first_name: string;
        last_name: string;
        email: string;
        customer_code: string;
        phone: string;
    };
    authorization: {
        authorization_code: string;
        card_type: string;
        bank: string;
        country_code: string;
        brand: string;
        account_name?: string;
        channel?: string;
        sender_bank?: string;
        sender_bank_account_number?: string;
        sender_country?: string;
        sender_name?: string;
        narration?: string;
        receiver_bank_account_number?: string;
        receiver_bank?: string;
    };
}

//customer identification success
export interface CustomerIdentificationSuccessData {
    customer_code: string;
    customer_id: string;
    email: string;
    identification: {
        bank_code: string;
        country: string;
        type: string;
    };
}

//dedicated account assign success
export interface DedicatedAccountAssignSuccessData {
    customer: {
        customer_code: string;
        email: string;
        first_name: string;
        last_name: string;
        id: string;
        meta: PaystackGenericData;
        phone: string;
    };
    dedicated_account: {
        account_name: string;
        account_number: string;
        active: boolean;
        assigned: boolean;
        bank: {
            id: number;
            name: string;
            slug: string;
        };
        assignment: {
            account_type: string;
        };
    };
}

export interface TransferData {
    amount: number;
    currency: string;
    domain: string;
    reference: string;
    source: string;
    status: string;
    transfer_code: string;
    recipient: {
        recipient_code: string;
        type: string;
        details: {
            account_number: string;
            account_name: string;
            bank_code: string;
            bank_name: string;
        };
    };
}

//meta data
interface ChargeSuccessMetadata {
    wallet_fund: boolean;
}

export interface PaystackWebhook {
    processWebhookEvent(eventBody: EventBody): Promise<void>;
}

export interface WebhookEventMap {
    "process-webhook-event": EventBody;
}
