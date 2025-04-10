export interface QuidaxGenericData {
    [key: string]: any;
}

export enum Event {
    WalletUpdatedEvent = "wallet.updated",
    WalletAddressGenerated = "wallet.address.generated",
    InstantOrderQuoted = "instant_order.pend",
    InstantOrderConfirmed = "instant_order.confirmed",
    InstantOrderDone = "instant_order.done",
    InstantOrderCancelled = "instant_order.cancelled",
    InstantOrderfailed = "instant_order.failed",

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
    // wallet events
    [Event.WalletUpdatedEvent]: WalletUpdatedData;
    [Event.WalletAddressGenerated]: WalletAddressGeneratedData;
    // instant order events
    [Event.InstantOrderQuoted]: InstantOrderData;
    [Event.InstantOrderConfirmed]: InstantOrderData;
    [Event.InstantOrderDone]: InstantOrderData;
    [Event.InstantOrderCancelled]: InstantOrderData;
    [Event.InstantOrderfailed]: InstantOrderData;

    // withdraw events

    // swap transaction events

    // deposit events

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

interface IQuidaxUser {
    id: string;
    sn: string;
    email: string;
    reference: string | null;
    first_name: string;
    last_name: string;
    display_name: string;
    created_at: string;
    updated_at: string;
}

export interface WalletUpdatedData {
    id: string;
    currency: string;
    balance: string;
    locked: string;
    staked: string;
    user: IQuidaxUser;
    converted_balance: string;
    reference_currency: string;
    is_crypto: boolean;
    created_at: string;
    updated_at: string;
    deposit_address: string;
    destination_tag: string | null;
}

export interface WalletAddressGeneratedData {
    id: string;
    reference: string | null;
    currency: string;
    address: string;
    network: string;
    user: IQuidaxUser;
    destination_tag: string | null;
    total_payments: string | null;
    created_at: string;
    updated_at: string;
}

export interface InstantOrderData {
    id: string;
    reference: string | null;
    market: {
        id: string;
        base_unit: string;
        quote_unit: string;
    };
    side: string;
    price: {
        unit: string;
        amount: string;
    };
    volume: {
        unit: string;
        amount: string;
    };
    total: {
        unit: string;
        amount: string;
    };
    fee: {
        unit: string;
        amount: string;
    };
    receive: {
        unit: string;
        amount: string;
    };
    status: "done" | "confirm" | "pend" | "cancel" | "failed";
    created_at: string;
    updated_at: string;
    user: IQuidaxUser;
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
