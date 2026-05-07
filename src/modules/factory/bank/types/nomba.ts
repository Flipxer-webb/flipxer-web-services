export interface NombaUserRecord {
    id: number;
    email: string;
    firstName: string;
    lastName: string;
    phoneNumber?: string | null;
}

export interface NombaResolveBankAccountOptions {
    account_number: string;
    bank_code: string;
}

export interface NombaResolveBankAccountResponse {
    accountNumber: string;
    accountName: string;
    bankCode: string;
}

export interface NombaInitializeTransferOptions {
    userId: number;
    amount: number;
    serviceCharge: number;
    reference: string;
    accountNumber: string;
    accountName: string;
    bankCode: string;
    bankName: string;
    orderId?: number;
    senderName?: string;
    senderEmail?: string;
    narration?: string;
}

export interface NombaInitializeRefundTransferOptions {
    userId: number;
    orderId: number;
    refundAttemptId: number;
    amount: number;
    reference: string;
    accountNumber: string;
    accountName?: string | null;
    bankCode: string;
    bankName?: string | null;
    senderName?: string;
    senderEmail?: string;
    narration?: string;
}

export interface NombaVirtualAccountOptions {
    userId: number;
    accountRef: string;
    accountName: string;
    expiryDate?: string;
}

export namespace TNomba {
    export interface INombaBank {
        getBanks(): Promise<any>;
        resolveBankAccount(
            options: NombaResolveBankAccountOptions
        ): Promise<{ status: boolean; data: NombaResolveBankAccountResponse }>;
        createVirtualAccount(
            user: NombaUserRecord,
            options?: Partial<NombaVirtualAccountOptions>
        ): Promise<any>;
        initializeTransfer(options: NombaInitializeTransferOptions): Promise<void>;
        initializeRefundTransfer(options: NombaInitializeRefundTransferOptions): Promise<{
            paymentId: number;
            externalReference?: string | null;
            providerReference?: string | null;
        }>;
        verifyTransferStatus(
            reference: string,
            externalReference?: string | null,
            providerReference?: string | null,
        ): Promise<{
            status: "success" | "failed" | "pending";
            data: any;
        }>;
        verifyRefundTransferStatus(
            reference: string,
            externalReference?: string | null,
            providerReference?: string | null,
        ): Promise<{
            status: "success" | "failed" | "pending";
            data: any;
        }>;
    }
}
