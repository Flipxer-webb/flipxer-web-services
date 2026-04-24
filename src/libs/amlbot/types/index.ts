export interface AmlBotOptions {
    baseURL: string;
    accessKey: string;
    accessId: string;
}

export interface AmlBotAddressCheckOptions {
    hash: string;
    asset: string;
    locale?: string;
}

export interface AmlBotTransactionCheckOptions {
    hash: string;
    address: string;
    direction: "deposit" | "withdrawal";
    asset: string;
    locale?: string;
}

export interface AmlBotRecheckOptions {
    uid: string;
}

export interface AmlBotHistoryOptions {
    page?: number;
    address?: 0 | 1;
    tx?: 0 | 1;
    asset?: string;
}

export interface AmlBotInvestigationOptions {
    hash: string;
    asset: string;
    expanded: 1;
    tokenData?: string;
    locale?: string;
}

// --- Response types ---

export interface AmlBotSignals {
    atm: number;
    dark_market: number;
    dark_service: number;
    exchange_fraudulent: number;
    exchange_mlrisk_high: number;
    exchange_mlrisk_low: number;
    exchange_mlrisk_moderate: number;
    exchange_mlrisk_veryhigh: number;
    gambling: number;
    illegal_service: number;
    marketplace: number;
    miner: number;
    mixer: number;
    p2p_exchange_mlrisk_high: number;
    p2p_exchange_mlrisk_low: number;
    payment: number;
    ransom: number;
    scam: number;
    stolen_coins: number;
    wallet: number;
}

export interface AmlBotCounterparty {
    name?: string;
    id?: number;
    type?: string;
    slug?: string;
    address?: string;
}

export interface AmlBotTokenDetails {
    code: string;
    issuer: string;
    token_id: number;
    precision: number;
}

export interface AmlBotAddressData {
    riskscore: number;
    signals: AmlBotSignals;
    updated_at: number;
    address: string;
    fiat_code_effective: string;
    counterparty: AmlBotCounterparty;
    reportedAddressBalance: number | null;
    blackListsConnections: boolean;
    pdfReport: string;
    asset: string;
    hasBlackListFlag: boolean;
    timestamp: string;
    // Async flow fields
    uid?: string;
    status?: "pending" | "success";
    network?: string;
}

export interface AmlBotTransactionData extends AmlBotAddressData {
    created_at: number;
    amount: number;
    risky_volume: number;
    direction: string;
    tx: string;
    risky_volume_fiat: number;
    tokenDetails?: AmlBotTokenDetails;
}

export interface AmlBotInvestigationConnection {
    entity: {
        id?: number;
        name: string;
        riskscore: number;
        slug?: string;
        subtype: string | null;
        type: string;
    };
    received: {
        direct?: number;
        hops: number | null;
        total: number;
    };
    sent: {
        direct?: number;
        hops: number | null;
        total: number;
    };
}

export interface AmlBotInvestigationData {
    indirects: {
        connections: AmlBotInvestigationConnection[];
        debug: any;
    };
    riskscore: number;
    counterparty: AmlBotCounterparty;
    asset: string;
    address: string;
    identifier: string;
    timestamp: string;
}

export interface AmlBotResponse<D = Record<string, any>> {
    result: boolean;
    balance?: number;
    discount?: string;
    promoFlow?: boolean;
    discountDueTime?: number;
    data: D;
    // Error response
    description?: string;
}

export interface AmlBotHistoryResponse {
    result: boolean;
    pageLimit: number;
    totalCount: string;
    data: AmlBotAddressData[];
    balance: number;
    discount: string;
    promoFlow: boolean;
}
