import { ApiProperty } from "@nestjs/swagger";
import {
    IsEnum,
    IsNotEmpty,
    IsNumber,
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

export class GetWalletDto {
    @ApiProperty({ enum: SupportedAssets })
    @IsNotEmpty()
    @IsEnum(SupportedAssets)
    asset: SupportedAssets;
}

export class InitiateWalletCreationDto {
    @ApiProperty({ enum: SupportedAssets })
    @IsNotEmpty()
    @IsEnum(SupportedAssets)
    asset: SupportedAssets;

    @ApiProperty({ enum: NetworkTypes })
    @IsNotEmpty()
    @IsEnum(NetworkTypes)
    network: NetworkTypes;
}

export class PlaceBuyOrSellOrderDto {
    @ApiProperty({ enum: TradingPair })
    @IsNotEmpty()
    @IsEnum(TradingPair)
    market: TradingPair;

    @ApiProperty({ enum: OrderType })
    @IsNotEmpty()
    @IsEnum(OrderType)
    order_type: OrderType;

    @ApiProperty({ enum: OrderSide })
    @IsNotEmpty()
    @IsEnum(OrderSide)
    order_side: OrderSide;

    @ApiProperty()
    @IsNotEmpty()
    @IsNumber()
    @IsPositive()
    volume: number;

    @ApiProperty({
        required: false,
        description:
            "Required if order_type is LIMIT. Not required for MARKET orders.",
    })
    @ValidateIf((o) => o.order_type === OrderType.LIMIT)
    @IsNotEmpty()
    @IsNumber()
    @IsPositive()
    price: number;
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
}
