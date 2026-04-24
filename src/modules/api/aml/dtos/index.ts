import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsNotEmpty, IsOptional, IsString } from "class-validator";

const SUPPORTED_ASSETS = [
    "BTC", "ETH", "BCH", "BSV", "LTC", "XRP", "ETC", "BSC", "BNB",
    "TRX", "MATIC", "ADA", "ZEC", "DOGE", "SOL", "ALGO",
] as const;

const DIRECTIONS = ["deposit", "withdrawal"] as const;

export class CheckAddressDto {
    @ApiProperty({ description: "Blockchain address to check", example: "1DSiYSqTvzGo9C4zgJniZbzxvL6CFWS1pA" })
    @IsNotEmpty()
    @IsString()
    hash: string;

    @ApiProperty({
        description: "Asset/currency code. Use ETH for ERC20 tokens, BSC for BEP20, TRX for TRC20",
        example: "BTC",
        enum: SUPPORTED_ASSETS,
    })
    @IsNotEmpty()
    @IsString()
    asset: string;
}

export class CheckTransactionDto {
    @ApiProperty({ description: "Transaction hash to check" })
    @IsNotEmpty()
    @IsString()
    hash: string;

    @ApiProperty({ description: "Address where funds were accepted" })
    @IsNotEmpty()
    @IsString()
    address: string;

    @ApiProperty({
        description: "Direction of the transaction relative to your address",
        enum: DIRECTIONS,
    })
    @IsNotEmpty()
    @IsIn(DIRECTIONS)
    direction: "deposit" | "withdrawal";

    @ApiProperty({
        description: "Asset/currency code",
        example: "BTC",
        enum: SUPPORTED_ASSETS,
    })
    @IsNotEmpty()
    @IsString()
    asset: string;
}

export class RecheckDto {
    @ApiProperty({ description: "UID from a pending check request" })
    @IsNotEmpty()
    @IsString()
    uid: string;
}

export class InvestigateAddressDto {
    @ApiProperty({ description: "Blockchain address to investigate" })
    @IsNotEmpty()
    @IsString()
    hash: string;

    @ApiProperty({
        description: "Asset/currency code",
        example: "ETH",
    })
    @IsNotEmpty()
    @IsString()
    asset: string;

    @ApiPropertyOptional({
        description: "Smart contract address for ERC20/BEP20 token verification",
        example: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    })
    @IsOptional()
    @IsString()
    tokenData?: string;
}

export class GetHistoryDto {
    @ApiPropertyOptional({ description: "Page number (0-based)", default: 0 })
    @IsOptional()
    page?: number;

    @ApiPropertyOptional({ description: "Filter by address checks (1 = only address, 0 = exclude address)" })
    @IsOptional()
    address?: 0 | 1;

    @ApiPropertyOptional({ description: "Filter by transaction checks (1 = only tx, 0 = exclude tx)" })
    @IsOptional()
    tx?: 0 | 1;

    @ApiPropertyOptional({ description: "Filter by asset" })
    @IsOptional()
    @IsString()
    asset?: string;
}
