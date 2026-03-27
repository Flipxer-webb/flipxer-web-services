import { IsString, IsNumber, IsOptional, ValidateNested } from "class-validator";
import { Type } from "class-transformer";

export enum NombaWebhookEventType {
    TRANSACTION_COMPLETED = "transaction.completed",
    TRANSFER_SUCCESSFUL = "transfer.successful",
    TRANSFER_FAILED = "transfer.failed",
    VIRTUAL_ACCOUNT_CREDITED = "virtual_account.credited",
}

export class NombaWebhookTransactionData {
    @IsString()
    id: string;

    @IsNumber()
    amount: number;

    @IsOptional()
    @IsNumber()
    fee?: number;

    @IsString()
    status: string;

    @IsOptional()
    @IsString()
    reference?: string;

    @IsOptional()
    @IsString()
    merchantTxRef?: string;

    @IsOptional()
    @IsString()
    accountRef?: string;

    @IsOptional()
    @IsString()
    accountNumber?: string;

    @IsOptional()
    @IsString()
    senderAccountNumber?: string;

    @IsOptional()
    @IsString()
    senderAccountName?: string;

    @IsOptional()
    @IsString()
    senderBankName?: string;

    @IsOptional()
    @IsString()
    narration?: string;

    @IsOptional()
    @IsString()
    createdAt?: string;
}

export class NombaWebhookPayload {
    @IsString()
    event: string;

    @ValidateNested()
    @Type(() => NombaWebhookTransactionData)
    data: NombaWebhookTransactionData;

    @IsOptional()
    @IsString()
    timestamp?: string;
}
