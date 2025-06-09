import { ApiProperty } from "@nestjs/swagger";
import {
    IsEnum,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsPositive,
    IsString,
    ValidateIf,
} from "class-validator";
import {
    OrderSide,
    OrderType,
    SupportedAssets,
    TradingPair,
} from "../interfaces/trade";
import { NetworkTypes } from "@prisma/client";
import { Transform } from "class-transformer";

export class GetWalletDto {
    @ApiProperty({ enum: SupportedAssets })
    @IsNotEmpty()
    @IsEnum(SupportedAssets)
    asset: SupportedAssets;

    @ApiProperty({ enum: NetworkTypes })
    @IsNotEmpty()
    @IsEnum(NetworkTypes)
    network: NetworkTypes;
}

export class InitiateWalletCreationDto {
    @ApiProperty({ enum: SupportedAssets })
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
}

export class VerifyWalletAddressDto {
    @ApiProperty()
    @IsNotEmpty()
    @IsString()
    address: string;

    @ApiProperty({ enum: SupportedAssets })
    @IsNotEmpty()
    @IsEnum(SupportedAssets)
    currency: SupportedAssets;
}

export class GetCryptoWithdrawerFeeDto {
    @ApiProperty({ enum: SupportedAssets })
    @IsNotEmpty()
    @IsEnum(SupportedAssets)
    currency: SupportedAssets;

    @ApiProperty({
        example: 0.01,
        description: "Amount of crypto the user wants to buy",
    })
    @Transform(({ value }) => +value)
    @IsNotEmpty()
    @IsPositive()
    @IsNumber()
    amount!: number;
}

export class PlaceInstantSwapRequestDto {
    @ApiProperty({ enum: SupportedAssets })
    @IsNotEmpty()
    @IsEnum(SupportedAssets)
    from_currency: SupportedAssets;

    @ApiProperty({ enum: SupportedAssets })
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
}

export class WithdrawerRequestDto {
    @ApiProperty({ enum: SupportedAssets, description: "allowed currencies" })
    @IsNotEmpty()
    @IsEnum(SupportedAssets)
    currency: SupportedAssets;

    @ApiProperty({ description: "value to be sent to the recipient." })
    @IsNotEmpty()
    @IsNumber()
    @IsPositive()
    amount: number;

    @ApiProperty({ description: "notes for the recipient" })
    @IsNotEmpty()
    @IsString()
    transaction_note: string;

    @ApiProperty({ description: "narration for the recipient" })
    @IsNotEmpty()
    @IsString()
    narration: string;

    @ApiProperty({ description: "crypto address" })
    @IsNotEmpty()
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
}

export class CancelWithdrawerRequestDto {
    @ApiProperty()
    @IsNotEmpty()
    @IsString()
    withdrawal_id: string;
}

export enum RampSide {
    on_ramp = "on_ramp",
    off_ramp = "off_ramp",
}

export class SupportedPaymentMethodDto {
    @ApiProperty({ enum: SupportedAssets })
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

// export interface PurchaseLimitBuyOptions {
//     currency_symbol: string;
// }

// export interface PurchaseLimitSellOptions {
//     token_symbol: string;
// }

// export interface PurchaseQuoteBuyOptions {
//     currency: string; //Fiat currency
//     token: string; //Token currency:
//     fiat_amount: string;
//     token_network: string;
// }

// export interface PurchaseQuoteSellOptions {
//     currency: string; //Fiat currency
//     token: string; //Token currency:
//     token_amount: string;
//     token_network: string;
// }
