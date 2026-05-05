import { IsBoolean, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString } from "class-validator";
import { Transform } from "class-transformer";
import { SUPPORTED_TRADE_ASSET_SYMBOLS } from "../constants";

export class CreateSwapPairDto {
    @IsNotEmpty()
    @IsString()
    @Transform(({ value }) => value?.toUpperCase())
    @IsIn(SUPPORTED_TRADE_ASSET_SYMBOLS)
    fromCurrency: string;

    @IsNotEmpty()
    @IsString()
    @Transform(({ value }) => value?.toUpperCase())
    @IsIn(SUPPORTED_TRADE_ASSET_SYMBOLS)
    toCurrency: string;

    @IsNotEmpty()
    @IsNumber()
    rate: number;

    @IsOptional()
    @IsBoolean()
    isActive?: boolean;
}

export class UpdateSwapPairDto {
    @IsOptional()
    @IsNumber()
    rate?: number;

    @IsOptional()
    @IsBoolean()
    isActive?: boolean;
}

export class BulkUpdateSwapPairDto {
    @IsNotEmpty()
    @Transform(({ value }) => value?.toUpperCase())
    @IsIn(SUPPORTED_TRADE_ASSET_SYMBOLS)
    targetCurrency: string; // e.g. "USDT"

    @IsOptional()
    @IsNumber()
    rateMultiplier: number; // e.g. 1.05 to increase all by 5%

    // Or set explicit rate? No, explicit rate varies by coin. 
    // Maybe just bulk enable/disable?
    @IsOptional()
    @IsBoolean()
    isActive?: boolean;
}
