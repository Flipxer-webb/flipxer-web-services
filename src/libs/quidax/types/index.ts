export interface QuidaxOptions {
    baseURL: string;
    api_public: string;
    api_secret: string;
}

export interface InstantOrdersRequeryOptions {
    instant_order_id: string;
    user_id?: string;
}

interface Market {
    id: string;
    base_unit: string;
    quote_unit: string;
}

interface CurrencyAmount {
    unit: string;
    amount: string;
}

interface User {
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

export interface InstantOrderResponse {
    id: string;
    reference: string | null;
    market: Market;
    side: "buy" | "sell";
    price: CurrencyAmount;
    volume: CurrencyAmount;
    total: CurrencyAmount;
    fee: CurrencyAmount;
    receive: CurrencyAmount;
    status: string;
    created_at: string;
    updated_at: string;
    user: User;
}

export interface QuidaxResponse<
    D extends Record<string, any> = Record<string, any>
> {
    status: string;
    message: string;
    data: D;
}
