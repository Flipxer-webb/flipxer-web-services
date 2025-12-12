import { ApiProperty } from "@nestjs/swagger";
import { PaginationQueryDto } from "../../user/dtos";
import {
    IsDateString,
    IsEnum,
    IsNumberString,
    IsOptional,
    IsString,
} from "class-validator";
import { OrderCategory, OrderStreamlinedStatus } from "@prisma/client";

export class GetUserTransactionListDto extends PaginationQueryDto {
    @ApiProperty({
        enum: OrderCategory,
        description: "filter by transaction type - optional",
        required: false,
    })
    @IsOptional()
    @IsEnum(OrderCategory)
    type?: OrderCategory;

    @ApiProperty({
        enum: OrderStreamlinedStatus,
        description: "filter by transaction status - optional",
        required: false,
    })
    @IsOptional()
    @IsEnum(OrderStreamlinedStatus)
    status?: OrderStreamlinedStatus;

    @ApiProperty({
        description: "filter by asset name or asset symbol- optional",
        example: "USDT",
        required: false,
    })
    @IsOptional()
    @IsString()
    asset?: string;

    @ApiProperty({
        description: "filter by start date - optional",
        example: "2024-01-01T00:00:00Z",
        required: false,
    })
    @IsOptional()
    @IsDateString()
    startDate?: string;

    @ApiProperty({
        description: "filter by end date  - optional",
        example: "2024-01-01T00:00:00Z",
        required: false,
    })
    @IsOptional()
    @IsDateString()
    endDate?: string;

    @ApiProperty({
        description: "search transaction using transaction id - optional",
        example: "74GCHH066AE1H44",
        required: false,
    })
    @IsOptional()
    @IsString()
    searchText?: string;
}

export class GeneralReportDownloadDto {
    @ApiProperty({
        enum: OrderCategory,
        description: "filter by transaction type - optional",
        required: false,
    })
    @IsOptional()
    @IsEnum(OrderCategory)
    type?: OrderCategory;

    @ApiProperty({
        description: "filter by start date",
        example: "2024-01-01T00:00:00Z",
    })
    @IsDateString()
    startDate: string;

    @ApiProperty({
        description: "filter by end date",
        example: "2025-12-01T00:00:00Z",
    })
    @IsDateString()
    endDate: string;
}

// ==================== ADMIN TRANSACTION DTOs ====================

export class UpdateTransactionStatusDto {
    @ApiProperty({
        enum: OrderStreamlinedStatus,
        description: "New status to set",
    })
    @IsEnum(OrderStreamlinedStatus)
    status: OrderStreamlinedStatus;

    @ApiProperty({
        description: "Reason for status change",
        required: false,
    })
    @IsOptional()
    @IsString()
    reason?: string;

    @ApiProperty({
        description: "Additional notes",
        required: false,
    })
    @IsOptional()
    @IsString()
    note?: string;
}

export class ManualApproveTransactionDto {
    @ApiProperty({
        description: "Confirmation that admin verified the transaction",
        required: true,
    })
    confirmed: boolean;

    @ApiProperty({
        description: "Verification note",
        required: false,
    })
    @IsOptional()
    @IsString()
    verificationNote?: string;

    @ApiProperty({
        description: "Override amount (if different from original)",
        required: false,
    })
    @IsOptional()
    @IsNumberString()
    overrideAmount?: string;
}

export class RefundTransactionDto {
    @ApiProperty({
        description: "Reason for refund",
        required: true,
    })
    @IsString()
    reason: string;

    @ApiProperty({
        description: "Refund amount (defaults to full amount)",
        required: false,
    })
    @IsOptional()
    @IsNumberString()
    amount?: string;

    @ApiProperty({
        description: "Type of refund",
        enum: ["full", "partial"],
        required: false,
    })
    @IsOptional()
    @IsString()
    type?: "full" | "partial";
}

export class GetTransactionAuditLogsDto {
    @ApiProperty({
        description: "Transaction ID",
        required: true,
    })
    @IsString()
    transactionId: string;
}

export class BulkTransactionActionDto {
    @ApiProperty({
        description: "Array of transaction IDs",
        type: [String],
    })
    transactionIds: string[];

    @ApiProperty({
        enum: OrderStreamlinedStatus,
        description: "New status to set",
    })
    @IsEnum(OrderStreamlinedStatus)
    status: OrderStreamlinedStatus;

    @ApiProperty({
        description: "Reason for bulk action",
        required: false,
    })
    @IsOptional()
    @IsString()
    reason?: string;
}

