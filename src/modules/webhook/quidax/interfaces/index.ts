export interface QuidaxGenericData {
    [key: string]: any;
}

export enum Event {
    //wallet
    WalletUpdatedEvent = "wallet.updated",
    WalletAddressGenerated = "wallet.address.generated",
    //swap
    SwapTransactionCompleted = "swap_transaction.completed",
    SwapTransactionRevered = "swap_transaction.reversed",
    SwapTransactionFailed = "swap_transaction.failed",
    //withdrawer
    WithdrawSuccessful = "withdraw.successful",
    WithdrawRejected = "withdraw.rejected",
    //order
    OrderDone = "order.done",
    OrderCancelled = "order.cancelled",

    InstantOrderQuoted = "instant_order.pend",
    InstantOrderConfirmed = "instant_order.confirmed",
    InstantOrderDone = "instant_order.done",
    InstantOrderCancelled = "instant_order.cancelled",
    InstantOrderfailed = "instant_order.failed",
}

export interface EventBody<E extends Event = Event> {
    event: E;
    data: E extends keyof EventDataMap ? EventDataMap[E] : never;
}

type EventDataMap = {
    // wallet events
    [Event.WalletUpdatedEvent]: WalletUpdatedData;
    [Event.WalletAddressGenerated]: WalletAddressGeneratedData;
    //swap
    [Event.SwapTransactionCompleted]: SwapTransactionEventData;
    [Event.SwapTransactionRevered]: SwapTransactionEventData;
    [Event.SwapTransactionFailed]: SwapTransactionEventData;
    // instant order events
    [Event.InstantOrderQuoted]: InstantOrderData;
    [Event.InstantOrderConfirmed]: InstantOrderData;
    [Event.InstantOrderDone]: InstantOrderData;
    [Event.InstantOrderCancelled]: InstantOrderData;
    [Event.InstantOrderfailed]: InstantOrderData;

    // withdraw events

    // swap transaction events

    // deposit events
};

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

export interface SwapTransactionEventData {
    id: string;
    from_currency: string;
    to_currency: string;
    from_amount: string;
    received_amount: string;
    execution_price: string;
    status: "completed" | "reversed" | "failed";
    created_at: string;
    updated_at: string;
    swap_quotation: SwapQuotation;
    user: IQuidaxUser;
}

export interface SwapQuotation {
    id: string;
    from_currency: string;
    to_currency: string;
    quoted_price: string;
    quoted_currency: string;
    from_amount: string;
    to_amount: string;
    confirmed: boolean;
    expires_at: string;
    created_at: string;
    updated_at: string;
    user: IQuidaxUser;
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
