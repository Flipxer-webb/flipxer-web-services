import { IsBoolean, IsNotEmpty, IsNumber, IsOptional, IsString } from "class-validator";
import { Transform } from "class-transformer";

export class CreateSwapPairDto {
    @IsNotEmpty()
    @IsString()
    @Transform(({ value }) => value?.toUpperCase())
    fromCurrency: string;

    @IsNotEmpty()
    @IsString()
    @Transform(({ value }) => value?.toUpperCase())
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
