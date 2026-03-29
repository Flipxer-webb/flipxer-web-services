import { ApiProperty } from "@nestjs/swagger";
import {
    IsEnum,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsPositive,
    IsString,
    Length,
    Matches,
    Min,
    ValidateNested,
    IsBoolean,
} from "class-validator";
import { SupportedAssets } from "../interfaces/trade";
import { NetworkTypes } from "@prisma/client";
import { Transform, Type } from "class-transformer";

export class GetWalletDto {
    @ApiProperty({ enum: SupportedAssets })
    @Transform(({ value }) => value?.toLowerCase())
    @IsNotEmpty()
    @IsEnum(SupportedAssets)
    asset: SupportedAssets;

    @ApiProperty({ enum: NetworkTypes })
    @IsNotEmpty()
    @IsEnum(NetworkTypes)
    network: NetworkTypes;
}

export class GetWalletAddressesDto {
    @ApiProperty({ enum: SupportedAssets })
    @Transform(({ value }) => value?.toLowerCase())
    @IsNotEmpty()
    @IsEnum(SupportedAssets)
    asset: SupportedAssets;
}

export class InitiateWalletCreationDto {
    @ApiProperty({ enum: SupportedAssets })
    @Transform(({ value }) => value?.toLowerCase())
    @IsNotEmpty()
    @IsEnum(SupportedAssets)
    asset: SupportedAssets;

    @ApiProperty({ enum: NetworkTypes })
    @IsOptional()
    @IsEnum(NetworkTypes)
    network?: NetworkTypes;
}

export class InitiateBuyOrderDto {
    @ApiProperty({ example: "BTC, USDT, USDC" })
    @IsNotEmpty()
    asset: string;

    @ApiProperty({
        example: 0.01,
        description: "Amount of crypto the user wants to buy",
    })
    @Transform(({ value }) => +value)
    @IsNotEmpty()
    @IsPositive()
    @IsNumber()
    amount: number;

    @ApiProperty({ description: "Security verification token", required: false })
    @IsOptional()
    @IsString()
    verificationToken?: string;
}

export class InitiateSellOrderDto {
    @ApiProperty({ example: "BTC, USDT, USDC" })
    @IsNotEmpty()
    asset: string;

    @ApiProperty({
        example: 0.01,
        description: "Amount of crypto the user wants to buy",
    })
    @Transform(({ value }) => +value)
    @IsNotEmpty()
    @IsPositive()
    @IsNumber()
    amount: number;
}

export class BuyCryptoOrderDto {
    @ApiProperty({ example: "BTC, USDT, USDC" })
    @IsNotEmpty()
    asset: string;

    @ApiProperty({
        example: 0.01,
        description: "Amount of crypto the user wants to buy",
    })
    @Transform(({ value }) => +value)
    @IsNotEmpty()
    @IsPositive()
    @IsNumber()
    amount: number;

    @ApiProperty({
        example: 1750,
        description: "Buy rate of crypto the user wants to buy",
    })
    @Transform(({ value }) => +value)
    @IsNotEmpty()
    @IsPositive()
    @IsNumber()
    buyRate: number;

    @ApiProperty({
        example: 750,
        description: "Charge for the transaction in fiat (Naira)",
    })
    @Transform(({ value }) => +value)
    @IsNotEmpty()
    @IsNumber()
    @Min(0)
    transactionFeeInFiat: number;

    @ApiProperty({
        example: 1950,
        description: "Total amount to pay for the transaction in fiat (Naira)",
    })
    @Transform(({ value }) => +value)
    @IsNotEmpty()
    @IsPositive()
    @IsNumber()
    totalAmountToPayInFiat: number;

    @ApiProperty({ description: "Security verification token", required: false })
    @IsOptional()
    @IsString()
    verificationToken?: string;

    @ApiProperty({ description: "Unique key to prevent duplicate buy orders", required: true })
    @IsNotEmpty()
    @IsString()
    idempotencyKey: string;
}

export class BankDetailDto {
    @ApiProperty({ example: "John Doe" })
    @IsNotEmpty()
    @IsString()
    accountName: string;

    @ApiProperty({ example: "0239399493" })
    @IsNotEmpty()
    @IsString()
    @Length(10, 10, { message: "Account number must be 10 digits" })
    @Matches(/^\d+$/, { message: "Account number must contain only digits" })
    accountNumber: string;

    @ApiProperty({ example: "Opay" })
    @IsNotEmpty()
    @IsString()
    bankName: string;

    @ApiProperty({ example: "095" })
    @IsNotEmpty()
    @IsString()
    bankCode: string;
}

export class SellCryptoOrderDto {
    @ApiProperty({ example: "BTC, USDT, USDC" })
    @IsNotEmpty()
    asset: string;

    @ApiProperty({
        example: 0.01,
        description: "Amount of crypto the user wants to sell",
    })
    @Transform(({ value }) => +value)
    @IsNotEmpty()
    @IsPositive()
    @IsNumber()
    amount: number;

    @ApiProperty({
        example: 1750,
        description: "Sell rate of crypto the user wants to sell",
    })
    @Transform(({ value }) => +value)
    @IsNotEmpty()
    @IsPositive()
    @IsNumber()
    sellRate: number;

    @ApiProperty({
        example: 750,
        description: "Charge for the transaction in fiat (Naira)",
    })
    @Transform(({ value }) => +value)
    @IsNotEmpty()
    @IsNumber()
    @Min(0)
    transactionFeeInFiat: number;

    @ApiProperty({
        example: 1950,
        description:
            "Total amount to receive for the transaction in fiat (Naira)",
    })
    @Transform(({ value }) => +value)
    @IsNotEmpty()
    @IsPositive()
    @IsNumber()
    totalToReceiveInFiat: number;

    @ApiProperty({ type: BankDetailDto })
    @IsNotEmpty()
    @ValidateNested()
    @Type(() => BankDetailDto)
    bankDetail: BankDetailDto;

    @ApiProperty({ description: "Security verification token", required: false })
    @IsOptional()
    @IsString()
    verificationToken?: string;

    @ApiProperty({ description: "Unique key to prevent duplicate orders", required: true })
    @IsNotEmpty()
    @IsString()
    idempotencyKey: string;
}

export class VerifyWalletAddressDto {
    @ApiProperty()
    @IsNotEmpty()
    @IsString()
    address: string;

    @ApiProperty({ enum: SupportedAssets })
    @Transform(({ value }) => value?.toLowerCase())
    @IsNotEmpty()
    @IsEnum(SupportedAssets)
    currency: SupportedAssets;

    @ApiProperty({ description: "Blockchain network for address validation", required: false })
    @IsOptional()
    @IsString()
    network?: string;
}

export class GetCryptoWithdrawerFeeDto {
    @ApiProperty({ enum: SupportedAssets })
    @Transform(({ value }) => value?.toLowerCase())
    @IsNotEmpty()
    @IsEnum(SupportedAssets)
    currency: SupportedAssets;

    @ApiProperty({
        example: 0.01,
        description: "Amount of crypto the user wants to withdraw",
    })
    @Transform(({ value }) => +value)
    @IsNotEmpty()
    @IsPositive()
    @IsNumber()
    amount!: number;

    @ApiProperty({
        enum: NetworkTypes,
        required: false,
        description: "Blockchain network for the withdrawal",
        example: "erc20",
    })
    @IsOptional()
    @IsEnum(NetworkTypes)
    network?: NetworkTypes;
}

export class PlaceInstantSwapRequestDto {
    @ApiProperty({ enum: SupportedAssets })
    @Transform(({ value }) => value?.toLowerCase())
    @IsNotEmpty()
    @IsEnum(SupportedAssets)
    from_currency: SupportedAssets;

    @ApiProperty({ enum: SupportedAssets })
    @Transform(({ value }) => value?.toLowerCase())
    @IsNotEmpty()
    @IsEnum(SupportedAssets)
    to_currency: SupportedAssets; //the currency you are swapping to.

    @ApiProperty({ required: false })
    @IsOptional()
    @IsNumber()
    @IsPositive()
    from_amount?: number; //the amount you want to swap.

    @ApiProperty({ required: false })
    @IsOptional()
    @IsNumber()
    @IsPositive()
    to_amount?: number; //the amount you want to swap to.
}

export class RefreshInstantSwapRequestDto extends PlaceInstantSwapRequestDto {
    @ApiProperty()
    @IsNotEmpty()
    @IsString()
    quotation_id: string;
}

export class ConfirmInstantSwapQuoteDto {
    @ApiProperty()
    @IsNotEmpty()
    @IsString()
    quotationId: string;

    // Optional fields for auto-refresh if quote has expired
    @ApiProperty({ enum: SupportedAssets, required: false, description: "Required for auto-refresh if quote expired" })
    @Transform(({ value }) => value?.toLowerCase())
    @IsOptional()
    @IsEnum(SupportedAssets)
    from_currency?: SupportedAssets;

    @ApiProperty({ enum: SupportedAssets, required: false, description: "Required for auto-refresh if quote expired" })
    @Transform(({ value }) => value?.toLowerCase())
    @IsOptional()
    @IsEnum(SupportedAssets)
    to_currency?: SupportedAssets;

    @ApiProperty({ required: false, description: "Amount to swap (for auto-refresh)" })
    @IsOptional()
    @IsNumber()
    @IsPositive()
    @Transform(({ value }) => +value)
    from_amount?: number;

    @ApiProperty({ description: "Security verification token", required: false })
    @IsOptional()
    @IsString()
    verificationToken?: string;
}

/**
 * DTO for atomic swap - combines quote and confirm in one operation.
 * This eliminates all timing issues with quote expiry.
 */
export class ExecuteAtomicSwapDto {
    @ApiProperty({ enum: SupportedAssets, description: "Currency to swap from" })
    @IsNotEmpty()
    @IsString()
    from_currency: string;

    @ApiProperty({ enum: SupportedAssets, description: "Currency to swap to" })
    @IsNotEmpty()
    @IsString()
    to_currency: string;

    @ApiProperty({ description: "Amount to swap" })
    @IsNotEmpty()
    @IsNumber()
    @IsPositive()
    @Transform(({ value }) => +value)
    from_amount: number;

    @ApiProperty({ description: "Security verification token", required: false })
    @IsOptional()
    @IsString()
    verificationToken?: string;
}

export class WithdrawerRequestDto {
    @ApiProperty({ enum: SupportedAssets, description: "allowed currencies" })
    @Transform(({ value }) => value?.toLowerCase())
    @IsNotEmpty()
    @IsEnum(SupportedAssets)
    currency: SupportedAssets;

    @ApiProperty({ description: "value to be sent to the recipient." })
    @IsNotEmpty()
    @IsNumber()
    @IsPositive()
    amount: number;

    @ApiProperty({ required: false })
    @Transform(({ value }) => value?.toLowerCase()?.trim())
    @IsOptional()
    @IsString()
    recipientEmail?: string;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsBoolean()
    isInternal?: boolean;

    @ApiProperty({ description: "notes for the recipient", required: false })
    @IsOptional()
    @IsString()
    transaction_note?: string;

    @ApiProperty({ description: "narration for the recipient", required: false })
    @IsOptional()
    @IsString()
    narration?: string;

    @ApiProperty({ description: "crypto address" })
    @IsOptional()
    @IsString()
    recipientWalletAddress: string; // wallet address

    @ApiProperty({
        description: "Optional: Blockchain network for the transaction",
        enum: NetworkTypes,
        required: false,
    })
    @IsOptional()
    @IsEnum(NetworkTypes)
    network?: string;

    @ApiProperty({ description: "destination tag", required: false })
    @IsOptional()
    @IsString()
    destinationTag?: string; //destination tag

    @ApiProperty({ description: "2FA verification code", required: false })
    @IsOptional()
    @IsString()
    twoFactorCode?: string;

    @ApiProperty({ description: "Security verification token", required: false })
    @IsOptional()
    @IsString()
    verificationToken?: string;

    @ApiProperty({ description: "Unique key for idempotency", required: false })
    @IsOptional()
    @IsString()
    idempotencyKey?: string;
}

export class CancelWithdrawerRequestDto {
    @ApiProperty()
    @IsNotEmpty()
    @IsString()
    withdrawal_id: string;
}

export class CancelOrderDto {
    @ApiProperty({ description: "The ID of the order to cancel" })
    @IsNotEmpty()
    @IsNumber()
    orderId: number;
}

export enum RampSide {
    on_ramp = "on_ramp",
    off_ramp = "off_ramp",
}

export class SupportedPaymentMethodDto {
    @ApiProperty({ enum: SupportedAssets })
    @Transform(({ value }) => value?.toLowerCase())
    @IsNotEmpty()
    @IsEnum(SupportedAssets)
    currency: SupportedAssets;

    @ApiProperty({ enum: RampSide })
    @IsNotEmpty()
    @IsEnum(RampSide)
    side: RampSide;
}

export class PurchaseLimitBuyDto {
    @ApiProperty({ description: "fiat currency symbol" })
    @IsNotEmpty()
    @IsString()
    currency_symbol: string;
}

export class GetMarketChartDto {
    @ApiProperty({
        example: "BTC",
        description: "Asset symbol (e.g., BTC, ETH, USDT)"
    })
    @IsNotEmpty()
    @IsString()
    asset: string;

    @ApiProperty({
        example: 7,
        description: "Number of days of data (1, 7, 30, 90, 365)",
        default: 7
    })
    @IsOptional()
    @Transform(({ value }) => +value)
    @IsNumber()
    @IsPositive()
    days?: number = 7;
}

export class GetBatchSparklinesDto {
    @ApiProperty({
        example: "BTC,ETH,USDT",
        description: "Comma-separated list of asset symbols"
    })
    @IsNotEmpty()
    @IsString()
    assets: string;
}
