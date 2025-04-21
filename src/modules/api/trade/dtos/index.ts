import { ApiProperty } from "@nestjs/swagger";
import { IsEnum, IsNotEmpty } from "class-validator";
import { SupportedAssets } from "../interfaces/trade";

export class GetWalletDto {
    @ApiProperty({ enum: SupportedAssets })
    @IsNotEmpty()
    @IsEnum(SupportedAssets, { message: "Invalid asset symbol" })
    asset: SupportedAssets;
}
