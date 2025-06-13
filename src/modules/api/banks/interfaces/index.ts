export interface BankDetail {
    id: number;
    userId: number;
    bankName: string;
    accountName: string;
    accountNumber: string;
    createdAt: Date;
    updatedAt: Date;
}

export enum AssetValueToBankTransferStatus {
    SUCCESS = "SUCCESS",
    FAILED = "FAILED",
}

export interface TransferFailedHandlerOptions {
    paymentReference: string;
    transferToBankStatus: AssetValueToBankTransferStatus;
}
