import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsString, IsOptional, IsNumber, IsIn, IsNotEmpty, IsArray } from "class-validator";
import { Type } from "class-transformer";

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
        description: "KYC status filter",
        enum: ["PENDING", "APPROVED", "REJECTED", "ESCALATED", "all"],
    })
    @IsOptional()
    @IsString()
    status?: string;

    @ApiPropertyOptional({
        description: "Verification type filter",
        enum: ["BVN", "NIN", "DOCUMENT", "ADDRESS", "BIOMETRIC", "INCOME", "BUSINESS_DOCUMENT", "all"],
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

    @ApiProperty({
        description: "Decision action",
        enum: ["APPROVE", "REJECT", "ESCALATE"],
    })
    @IsString()
    @IsIn(["APPROVE", "REJECT", "ESCALATE"])
    action: "APPROVE" | "REJECT" | "ESCALATE";

    @ApiPropertyOptional({ description: "Verification type to update" })
    @IsOptional()
    @IsString()
    verificationType?: string;

    @ApiPropertyOptional({ description: "Review note/reason" })
    @IsOptional()
    @IsString()
    note?: string;

    @ApiPropertyOptional({ description: "New tier level (if approving)" })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    newTier?: number;
}

export class BulkKycDecisionDto {
    @ApiProperty({ description: "Array of user IDs" })
    @IsArray()
    @IsNumber({}, { each: true })
    userIds: number[];

    @ApiProperty({
        description: "Decision action",
        enum: ["APPROVE", "REJECT"],
    })
    @IsString()
    @IsIn(["APPROVE", "REJECT"])
    action: "APPROVE" | "REJECT";

    @ApiPropertyOptional({ description: "Review note" })
    @IsOptional()
    @IsString()
    note?: string;

    @ApiPropertyOptional({ description: "New tier level (if approving)" })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    newTier?: number;
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
    isBvnVerified?: boolean;

    @ApiPropertyOptional({ description: "NIN verification status" })
    @IsOptional()
    isNinVerified?: boolean;

    @ApiPropertyOptional({ description: "Document verification status" })
    @IsOptional()
    isDocumentVerified?: boolean;

    @ApiPropertyOptional({ description: "Address verification status" })
    @IsOptional()
    isAddressVerified?: boolean;

    @ApiPropertyOptional({ description: "Income verification status" })
    @IsOptional()
    isIncomeVerified?: boolean;

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
}
