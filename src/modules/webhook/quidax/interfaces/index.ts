export interface QuidaxGenericData {
    [key: string]: any;
}

export enum Event {
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

export interface QuidaxWebhook {
    processWebhookEvent(eventBody: EventBody): Promise<void>;
}

export interface WebhookEventMap {
    "process-webhook-event": EventBody;
}
