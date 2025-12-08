export interface TermiiOptions {
    apiKey: string;
    baseUrl?: string;
}

export interface SendSmsOptions {
    to: string;
    sms: string;
    from: string;
    type?: "plain" | "unicode";
    channel?: "generic" | "dnd" | "whatsapp";
}

export interface TermiiResponse<T = any> {
    code: string;
    message_id?: string;
    message?: string;
    balance?: number;
    user?: string;
}

export interface SendSmsResponse {
    code: string;
    message_id: string;
    message: string;
    balance: number;
    user: string;
}

export interface SendOtpOptions {
    to: string;
    from: string;
    messageType: "NUMERIC" | "ALPHANUMERIC";
    pinAttempts: number;
    pinTimeToLive: number; // in minutes
    pinLength: number;
    pinPlaceholder: string;
    messageText: string;
    channel?: "generic" | "dnd" | "whatsapp";
}

export interface SendOtpResponse {
    pinId: string;
    to: string;
    smsStatus: string;
}

export interface VerifyOtpOptions {
    pinId: string;
    pin: string;
}

export interface VerifyOtpResponse {
    pinId: string;
    verified: boolean;
    msisdn: string;
}

export interface BalanceResponse {
    user: string;
    balance: number;
    currency: string;
}
