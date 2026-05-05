import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsString, IsOptional, IsNumber, IsIn, IsNotEmpty } from "class-validator";
import { Type } from "class-transformer";

export const adminKycProviderLookupTypes = ["BVN", "NIN", "DOCUMENT", "ADDRESS", "INCOME", "BUSINESS_DOCUMENT"] as const;
export const adminKycLookupProviders = ["DOJAH", "OCR"] as const;

export type AdminKycProviderLookupType = typeof adminKycProviderLookupTypes[number];
export type AdminKycLookupProvider = typeof adminKycLookupProviders[number];

export class GetKycQueueDto {
    @ApiPropertyOptional({ description: "Page number", default: 1 })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    pageNumber?: number;

    @ApiPropertyOptional({ description: "Page size", default: 20 })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    pageSize?: number;

    @ApiPropertyOptional({
        description: "Queue workspace view",
        enum: ["ACTIONABLE", "AWAITING_USER", "RESOLVED", "all"],
    })
    @IsOptional()
    @IsString()
    queueView?: string;

    @ApiPropertyOptional({
        description: "KYC status filter",
        enum: ["PENDING", "NEEDS_REVIEW", "APPROVED", "REJECTED", "ESCALATED", "all"],
    })
    @IsOptional()
    @IsString()
    status?: string;

    @ApiPropertyOptional({
        description: "Verification type filter",
        enum: ["BVN", "NIN", "DOCUMENT", "ADDRESS", "INCOME", "BUSINESS_DOCUMENT", "all"],
    })
    @IsOptional()
    @IsString()
    verificationType?: string;

    @ApiPropertyOptional({ description: "Search by user email or name" })
    @IsOptional()
    @IsString()
    searchText?: string;

    @ApiPropertyOptional({ description: "Filter by tier level" })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    tier?: number;

    @ApiPropertyOptional({ description: "Sort order", enum: ["asc", "desc"], default: "desc" })
    @IsOptional()
    @IsString()
    sortBy?: "asc" | "desc";
}

export class KycDecisionDto {
    @ApiProperty({ description: "User ID to approve/reject KYC" })
    @IsNumber()
    userId: number;

    @ApiPropertyOptional({
        description: "Decision action",
        enum: ["APPROVE", "REJECT", "ESCALATE"],
    })
    @IsOptional()
    @IsString()
    @IsIn(["APPROVE", "REJECT", "ESCALATE"])
    action?: "APPROVE" | "REJECT" | "ESCALATE";

    @ApiProperty({ description: "Verification type to update" })
    @IsString()
    @IsNotEmpty()
    verificationType: string;

    @ApiPropertyOptional({ description: "Expected active verification version for optimistic locking" })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    version?: number;

    @ApiPropertyOptional({ description: "Review note/reason" })
    @IsOptional()
    @IsString()
    note?: string;

    // newTier removed — tier is always derived from verification flags via syncTierAndCache
}

export class AdminKycAttemptDecisionDto {
    @ApiProperty({
        description: "Decision action for the targeted KYC attempt",
        enum: ["APPROVE", "REJECT", "ESCALATE"],
    })
    @IsString()
    @IsIn(["APPROVE", "REJECT", "ESCALATE"])
    action: "APPROVE" | "REJECT" | "ESCALATE";

    @ApiProperty({ description: "Expected attempt version for optimistic locking" })
    @Type(() => Number)
    @IsNumber()
    expectedVersion: number;

    @ApiPropertyOptional({ description: "Verification type for the targeted attempt. Required when the attemptId refers to a staged attempt." })
    @IsOptional()
    @IsString()
    verificationType?: string;

    @ApiPropertyOptional({ description: "Review note or rejection reason" })
    @IsOptional()
    @IsString()
    note?: string;
}

export class RunKycAttemptRecheckDto {
    @ApiProperty({
        description: "Provider to re-run for the targeted KYC attempt",
        enum: adminKycLookupProviders,
    })
    @IsString()
    @IsIn(adminKycLookupProviders)
    provider: AdminKycLookupProvider;

    @ApiPropertyOptional({ description: "Optional note captured with the recheck request" })
    @IsOptional()
    @IsString()
    note?: string;

    @ApiPropertyOptional({ description: "Verification type for the targeted attempt. Required when the attemptId refers to a staged attempt." })
    @IsOptional()
    @IsString()
    verificationType?: string;
}

export class UpdateUserTierDto {
    @ApiProperty({ description: "New tier level" })
    @IsNumber()
    tier: number;

    @ApiPropertyOptional({ description: "Reason for tier change" })
    @IsOptional()
    @IsString()
    reason?: string;
}

export class UpdateUserVerificationDto {
    @ApiPropertyOptional({ description: "BVN verification status" })
    @IsOptional()
    bvnVerified?: boolean;

    @ApiPropertyOptional({ description: "NIN verification status" })
    @IsOptional()
    ninVerified?: boolean;

    @ApiPropertyOptional({ description: "Document verification status" })
    @IsOptional()
    documentVerified?: boolean;

    @ApiPropertyOptional({ description: "Address verification status" })
    @IsOptional()
    addressVerified?: boolean;

    @ApiPropertyOptional({ description: "Income verification status" })
    @IsOptional()
    incomeVerified?: boolean;

    @ApiPropertyOptional({ description: "Reason for manual update" })
    @IsOptional()
    @IsString()
    reason?: string;
}

export class GetKycStatsDto {
    @ApiPropertyOptional({
        description: "Time period",
        enum: ["today", "week", "month", "quarter", "year"],
        default: "month",
    })
    @IsOptional()
    @IsString()
    period?: string;

    @ApiPropertyOptional({ description: "Start date (ISO string) - overrides period" })
    @IsOptional()
    @IsString()
    startDate?: string;

    @ApiPropertyOptional({ description: "End date (ISO string) - overrides period" })
    @IsOptional()
    @IsString()
    endDate?: string;
}

export class ApproveDocumentDto {
    @ApiProperty({ description: "User ID" })
    @IsNumber()
    @Type(() => Number)
    userId: number;

    @ApiProperty({
        description: "Document type to approve",
        enum: ["address", "income", "business"],
    })
    @IsString()
    @IsIn(["address", "income", "business"])
    documentType: "address" | "income" | "business";

    @ApiPropertyOptional({ description: "Expected active verification version for optimistic locking" })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    version?: number;
}

export class RejectDocumentDto {
    @ApiProperty({ description: "User ID" })
    @IsNumber()
    @Type(() => Number)
    userId: number;

    @ApiProperty({
        description: "Document type to reject",
        enum: ["address", "income", "business"],
    })
    @IsString()
    @IsIn(["address", "income", "business"])
    documentType: "address" | "income" | "business";

    @ApiProperty({ description: "Reason for rejection" })
    @IsString()
    @IsNotEmpty()
    reason: string;

    @ApiPropertyOptional({ description: "Expected active verification version for optimistic locking" })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    version?: number;
}

export class RunKycProviderLookupDto {
    @ApiProperty({ description: "User ID" })
    @IsNumber()
    @Type(() => Number)
    userId: number;

    @ApiProperty({
        description: "Verification artifact to recheck with the provider",
        enum: adminKycProviderLookupTypes,
    })
    @IsString()
    @IsIn(adminKycProviderLookupTypes)
    verificationType: AdminKycProviderLookupType;
}
