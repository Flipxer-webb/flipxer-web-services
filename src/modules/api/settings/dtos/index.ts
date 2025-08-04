import { ApiProperty } from "@nestjs/swagger";
import { TransactionFeeCategory } from "@prisma/client";
import {
    IsEnum,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsString,
    Matches,
    Min,
} from "class-validator";

export class CreateOrUpdateCryptoRateDto {
    @ApiProperty({ description: "crypto currency name" })
    @IsNotEmpty()
    @IsString()
    currency: string;

    @ApiProperty({ description: "crypto buyRate", required: false })
    @IsOptional()
    @IsNumber()
    @Min(0)
    buyRate?: number;

    @ApiProperty({ description: "crypto sellRate", required: false })
    @IsOptional()
    @IsNumber()
    @Min(0)
    sellRate?: number;
}

export class CreateOrUpdateCryptoTransactionFeeDto {
    @ApiProperty({ description: "crypto transaction fee category" })
    @IsNotEmpty()
    @IsEnum(TransactionFeeCategory)
    category: TransactionFeeCategory;

    @ApiProperty({ description: "crypto currency name" })
    @IsNotEmpty()
    @IsString()
    currency: string;

    @ApiProperty({ description: "crypto transaction fee", required: false })
    @IsOptional()
    @IsNumber()
    @Min(0)
    fee?: number;
}

export class GetCryptoTransactionFeePerAssetDto {
    @ApiProperty({
        description: "crypto transaction fee category",
        enum: TransactionFeeCategory,
    })
    @IsNotEmpty()
    @IsEnum(TransactionFeeCategory)
    category: TransactionFeeCategory;
}

export class AddAllowedIpDto {
    @ApiProperty({
        description: "Public IP address to allow (IPv4 or IPv6)",
        example: "102.89.23.11",
    })
    @IsNotEmpty({ message: "IP address is required" })
    @IsString({ message: "IP address must be a string" })
    @Matches(/^(?!0)(?!.*\.$)((25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.|$)){4}$/, {
        message: "Invalid IPv4 format",
    })
    ip: string;

    @ApiProperty({
        required: false,
        description: "Optional label for the IP address",
        example: "Home Wi-Fi",
    })
    @IsOptional()
    @IsString({ message: "Label must be a string" })
    label?: string;
}

export class UpdateAllowedIpDto {
    @ApiProperty({
        required: false,
        description: "New label for the allowed IP",
        example: "Office Network",
    })
    @IsOptional()
    @IsString()
    label?: string;

    @ApiProperty({
        required: false,
        description: "Activate or deactivate this IP",
        example: true,
    })
    @IsOptional()
    isActive?: boolean;
}
