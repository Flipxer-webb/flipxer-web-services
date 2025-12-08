export interface SmsServiceInterface {
    sendSms(to: string, message: string): Promise<void>;
    sendVerificationCode(to: string, code: string): Promise<void>;
}

export interface SendSmsResult {
    success: boolean;
    messageId?: string;
    error?: string;
}
