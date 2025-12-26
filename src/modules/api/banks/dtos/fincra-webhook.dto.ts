import { IsString, IsOptional, IsObject } from 'class-validator';

/**
 * Fincra Webhook Payload DTO
 * 
 * This matches the payload structure that Fincra sends for collection webhooks.
 * Events include:
 * - collection.successful
 * - collection.failed
 * - collection.pending
 */
export class FincraWebhookPayloadDto {
    @IsString()
    event: string;

    @IsObject()
    data: {
        reference: string;
        merchantReference?: string;
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
