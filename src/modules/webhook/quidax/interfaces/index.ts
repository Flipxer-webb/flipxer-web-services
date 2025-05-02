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
    //deposit
    DepositTransactionConfirmation = "deposit.transaction.confirmation",
    DepositTransactionSuccessful = "deposit.successful",
    DepositTransactionOnHold = "deposit.on_hold",
    DepositTransactionFailedAml = "deposit.failed_aml",

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
    // withdraw events
    [Event.WithdrawSuccessful]: WithdrawerEventData;
    [Event.WithdrawRejected]: WithdrawerEventData;
    // deposit events
    [Event.DepositTransactionConfirmation]: DepositTransactionEventData;
    [Event.DepositTransactionSuccessful]: DepositTransactionEventData;
    [Event.DepositTransactionOnHold]: DepositTransactionEventData;
    [Event.DepositTransactionFailedAml]: DepositTransactionEventData;

    // instant order events
    [Event.InstantOrderQuoted]: InstantOrderData;
    [Event.InstantOrderConfirmed]: InstantOrderData;
    [Event.InstantOrderDone]: InstantOrderData;
    [Event.InstantOrderCancelled]: InstantOrderData;
    [Event.InstantOrderfailed]: InstantOrderData;
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

export interface WithdrawerEventData {
    id: string;
    reference: string | null;
    type: "internal" | string;
    currency: string;
    amount: string;
    fee: string;
    total: string;
    txid: string;
    transaction_note: string;
    narration: string;
    status: "Processing" | "Done" | "Rejected";
    reason: string | null;
    created_at: string; // ISO date string
    done_at: string | null;

    recipient: {
        type: "internal" | string;
        details: {
            user_id: string;
            address: string;
            destination_tag: string | null;
            name: string | null;
        };
    };

    wallet: {
        id: string;
        currency: string;
        balance: string;
        locked: string;
        staked: string;
        converted_balance: string;
        reference_currency: string;
        is_crypto: boolean;
        created_at: string;
        updated_at: string;
    };

    user: IQuidaxUser;
}

export interface DepositTransactionEventData {
    id: string;
    type: string;
    currency: string;
    amount: string;
    fee: string;
    txid: string;
    status: string;
    reason: string | null;
    created_at: string;
    done_at: string | null;
    wallet: {
        id: string;
        name: string;
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
        blockchain_enabled: boolean;
        default_network: string;
        networks: Network[];
        deposit_address: string;
        destination_tag: string | null;
    };
    user: IQuidaxUser;
    payment_transaction: {
        status: string;
        confirmations: number;
        required_confirmations: number;
    };
    payment_address: {
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
    };
}

export interface Network {
    id: string;
    name: string;
    deposits_enabled: boolean;
    withdraws_enabled: boolean;
}

export interface QuidaxWebhook {
    processWebhookEvent(eventBody: EventBody): Promise<void>;
}

export interface WebhookEventMap {
    "process-webhook-event": EventBody;
}
