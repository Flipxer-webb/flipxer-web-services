import { Type } from "class-transformer";
import { IsNumber, IsObject, IsOptional, IsString, ValidateNested } from "class-validator";

export enum PaymentWebhookSourceEventName {
    TRANSACTION_COMPLETED = "transaction.completed",
    TRANSFER_SUCCESSFUL = "transfer.successful",
    TRANSFER_FAILED = "transfer.failed",
    VIRTUAL_ACCOUNT_CREDITED = "virtual_account.credited",
}

export class PaymentWebhookEventDataDto {
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
    narration?: string;

    @IsOptional()
    @IsString()
    createdAt?: string;
}

export class PaymentWebhookEventEnvelopeDto {
    @IsString()
    event: string;

    @ValidateNested()
    @Type(() => PaymentWebhookEventDataDto)
    data: PaymentWebhookEventDataDto;

    @IsOptional()
    @IsString()
    timestamp?: string;
}

export class PaymentGatewayWebhookPayloadDto {
    @IsString()
    event: string;

    @IsObject()
    data: {
        reference: string;
        merchantReference?: string;
        customerReference?: string;
        status: string;
        amount: number;
        amountReceived?: number;
        fee?: number;
        currency: string;
        customer?: {
            name: string;
            email: string;
            phoneNumber?: string;
        };
        metadata?: Record<string, unknown>;
    };
}