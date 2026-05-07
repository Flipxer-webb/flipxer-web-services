import type { BankProvider } from "./index";

export interface RefundTransferOptions {
    provider: BankProvider;
    amount: number;
    accountName?: string | null;
    accountNumber: string;
    bankCode: string;
    bankName?: string | null;
    userId: number;
    orderId: number;
    refundAttemptId: number;
    reference: string;
    senderName?: string;
    senderEmail?: string;
    narration?: string;
}

export interface RefundTransferExecutionResult {
    paymentId: number;
    externalReference?: string | null;
    providerReference?: string | null;
}

export interface VerifyRefundTransferOptions {
    provider: BankProvider;
    reference: string;
    externalReference?: string | null;
    providerReference?: string | null;
}

export interface VerifiedRefundTransfer {
    provider: BankProvider;
    status: "success" | "failed" | "pending";
    data: any;
}