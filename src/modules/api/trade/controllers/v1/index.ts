import { SwaggerResponse, ApiResponse } from "@/utils/api-response-util";
import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    Query,
    UseGuards,
    ValidationPipe,
} from "@nestjs/common";

import { TradingService } from "../../services";
import {
    ApiTags,
    ApiOperation,
    ApiBearerAuth,
    ApiBody,
    ApiResponse as SwaggerApiResponse,
} from "@nestjs/swagger";
import { AuthGuard } from "@/modules/api/auth/guard";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { User } from "@/modules/api/user";
import { User as UserModel } from "@prisma/client";
import {
    GetCryptoWithdrawerFeeDto,
    GetWalletDto,
    InitiateWalletCreationDto,
    PlaceBuyOrSellOrderDto,
    VerifyWalletAddressDto,
} from "../../dtos";

@ApiTags("trade")
@Controller({
    path: "trades",
})
export class TradingController {
    constructor(private tradingService: TradingService) {}

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "get supported assets list" })
    @Get("supported-assets")
    async getSupportedAssets() {
        return this.tradingService.getSupportedAssets();
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "get supported network list" })
    @Get("supported-networks")
    async getSupportedNetworks() {
        return this.tradingService.getSupportedNetworks();
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "get supported trading pair list" })
    @Get("supported-trading-pairs")
    async getSupportedTradingPairs() {
        return this.tradingService.getSupportedTradingPairs();
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "verify wallet address" })
    @Get("verify-wallet-address")
    async verifyWalletAddress(@Query() dto: VerifyWalletAddressDto) {
        return this.tradingService.verifyWalletAddress(dto);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "get crypto withdrawer fee" })
    @Get("withdrawer-fee")
    async getWithdrawerFee(@Query() dto: GetCryptoWithdrawerFeeDto) {
        return this.tradingService.getCryptoWithdrawerFee(dto);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "get wallet info" })
    @UseGuards(AuthGuard)
    @ApiBearerAuth("access-token")
    @Get("get-wallet-info")
    async getWalletAddress(
        @Query() dto: GetWalletDto,
        @User() user: UserModel
    ) {
        return await this.tradingService.getWalletAddress(user.id, dto);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary:
            "initiate wallet and wallet address generation for non default assets",
    })
    @UseGuards(AuthGuard)
    @ApiBearerAuth("access-token")
    @Post("initiate-wallet-generation")
    async initiateWalletCreation(
        @Body() dto: InitiateWalletCreationDto,
        @User() user: UserModel
    ) {
        return await this.tradingService.initiateWalletCreation(user.id, dto);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary:
            "manual crypto account creation for user that missed auto generation",
    })
    @UseGuards(AuthGuard)
    @ApiBearerAuth("access-token")
    @Post("crypto-account-creation-manual-trigger")
    async triggerQuidaxAccountCreation(@User() user: UserModel) {
        return await this.tradingService.triggerQuidaxAccountCreation(user);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: "place buy or sell order",
    })
    @UseGuards(AuthGuard)
    @ApiBearerAuth("access-token")
    @Post("buy-or-Sell")
    async buyOrSellCrypto(
        @Body() dto: PlaceBuyOrSellOrderDto,
        @User() user: UserModel
    ) {
        return await this.tradingService.buyOrSellCrypto(user, dto);
    }
}
