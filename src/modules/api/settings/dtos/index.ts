import { ApiProperty } from "@nestjs/swagger";
import { TransactionFeeCategory } from "@prisma/client";
import {
    IsEnum,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsString,
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
