// import { ApiResponse } from "@/utils/api-response-util";
import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Post,
    Query,
    UseGuards,
} from "@nestjs/common";
import { TradingService } from "../../services";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiBody } from "@nestjs/swagger";
import {
    AuthGuard,
    CountryBlockGuard,
    TransactionAmountGuard,
    TwoFactorGuard,
} from "@/modules/api/auth/guard";
// import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { User } from "@/modules/api/user";
import { User as UserModel } from "@prisma/client";
import {
    BuyCryptoOrderDto,
    CancelWithdrawerRequestDto,
    ConfirmInstantSwapQuoteDto,
    GetCryptoWithdrawerFeeDto,
    GetWalletDto,
    GetWalletAddressesDto,
    InitiateBuyOrderDto,
    InitiateSellOrderDto,
    InitiateWalletCreationDto,
    PlaceInstantSwapRequestDto,
    PurchaseLimitBuyDto,
    RefreshInstantSwapRequestDto,
    SellCryptoOrderDto,
    SupportedPaymentMethodDto,
    VerifyWalletAddressDto,
    WithdrawerRequestDto,
} from "../../dtos";

@UseGuards(CountryBlockGuard)
@ApiTags("trade")
@Controller({
    path: "trades",
})
export class TradingController {
    constructor(private readonly tradingService: TradingService) {}

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "List supported assets" })
    @Get("supported-assets")
    async getSupportedAssets() {
        return this.tradingService.getSupportedAssets();
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "List supported payment methods" })
    @Get("supported-payment-methods")
    async getSupportedPaymentMethod(@Query() query: SupportedPaymentMethodDto) {
        return this.tradingService.getSupportedPaymentMethod(query);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "List supported networks" })
    @Get("supported-networks")
    async getSupportedNetworks() {
        return this.tradingService.getSupportedNetworks();
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "List supported trading pairs" })
    @Get("supported-trading-pairs")
    async getSupportedTradingPairs() {
        return this.tradingService.getSupportedTradingPairs();
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Get buy purchase limits" })
    @Get("purchase-limits/buy")
    async getPurchaseLimitForBuy(@Query() query: PurchaseLimitBuyDto) {
        return this.tradingService.getPurchaseLimitForBuy(query);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Verify wallet address" })
    @Get("verify-wallet-address")
    async verifyWalletAddress(@Query() dto: VerifyWalletAddressDto) {
        return this.tradingService.verifyWalletAddress(dto);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Get crypto withdrawal fee" })
    @Get("withdrawer-fee")
    async getWithdrawerFee(@Query() dto: GetCryptoWithdrawerFeeDto) {
        return this.tradingService.getCryptoWithdrawerFee(dto);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Get wallet info for authenticated user" })
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
        summary: "Get all wallet addresses for an asset (auth user)",
    })
    @UseGuards(AuthGuard)
    @ApiBearerAuth("access-token")
    @Get("wallet-addresses")
    async getWalletAddresses(
        @Query() dto: GetWalletAddressesDto,
        @User() user: UserModel
    ) {
        return await this.tradingService.getWalletAddresses(user.id, dto);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Initiate wallet address generation for user" })
    @UseGuards(AuthGuard)
    @ApiBearerAuth("access-token")
    @Post("initiate-wallet-address-generation")
    async initiateWalletCreation(
        @Body() dto: InitiateWalletCreationDto,
        @User() user: UserModel
    ) {
        return await this.tradingService.initiateWalletAddressCreation(
            user.id,
            dto
        );
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Manually trigger crypto account creation" })
    @UseGuards(AuthGuard)
    @ApiBearerAuth("access-token")
    @Post("crypto-account-creation-manual-trigger")
    async triggerQuidaxAccountCreation(@User() user: UserModel) {
        return await this.tradingService.triggerQuidaxAccountCreation(user);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Initiate buy order" })
    @UseGuards(AuthGuard)
    @ApiBearerAuth("access-token")
    @Post("buy/quote")
    async buyCrypto(@Body() dto: InitiateBuyOrderDto, @User() user: UserModel) {
        return await this.tradingService.buyCryptoQuoteRequest(user, dto);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary:
            "Confirm buy order; blocks if user is flagged or exceeds daily ($5,000/$10,000) or monthly ($100,000/$500,000) limits, flags user for monthly violations",
    })
    @UseGuards(AuthGuard, TransactionAmountGuard)
    @ApiBearerAuth("access-token")
    @Post("buy/order")
    async buyCryptoOrder(
        @Body() dto: BuyCryptoOrderDto,
        @User() user: UserModel
    ) {
        return await this.tradingService.buyCryptoOrder(user, dto);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Initiate sell order" })
    @UseGuards(AuthGuard)
    @ApiBearerAuth("access-token")
    @Post("sell/quote")
    async sellCryptoRequest(
        @Body() dto: InitiateSellOrderDto,
        @User() user: UserModel
    ) {
        return await this.tradingService.sellCryptoQuoteRequest(user, dto);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary:
            "Confirm sell order; blocks if user is flagged or exceeds daily ($5,000/$10,000) or monthly ($100,000/$500,000) limits, flags user for monthly violations",
    })
    @UseGuards(AuthGuard, TransactionAmountGuard, TwoFactorGuard)
    @ApiBearerAuth("access-token")
    @Post("sell/order")
    async sellCryptoOrder(
        @Body() dto: SellCryptoOrderDto,
        @User() user: UserModel
    ) {
        return await this.tradingService.sellCryptoOrder(user, dto);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Generate instant swap quote (valid for 15s)" })
    @UseGuards(AuthGuard)
    @ApiBearerAuth("access-token")
    @Post("request-instant-swap-quote")
    async createInstantSwap(
        @Body() dto: PlaceInstantSwapRequestDto,
        @User() user: UserModel
    ) {
        return await this.tradingService.createInstantSwap(user, dto);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Confirm instant swap quote" })
    @UseGuards(AuthGuard, TwoFactorGuard)
    @ApiBearerAuth("access-token")
    @Post("confirm-instant-swap-quote")
    async confirmInstantSwapQuote(
        @Body() dto: ConfirmInstantSwapQuoteDto,
        @User() user: UserModel
    ) {
        return await this.tradingService.confirmInstantSwapQuote(user, dto);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Refresh instant swap quote" })
    @UseGuards(AuthGuard)
    @ApiBearerAuth("access-token")
    @Post("refresh-instant-swap-quote")
    async refreshInstantSwapQuote(
        @Body() dto: RefreshInstantSwapRequestDto,
        @User() user: UserModel
    ) {
        return await this.tradingService.refreshInstantSwap(user, dto);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Initiate withdrawal" })
    @UseGuards(AuthGuard, TransactionAmountGuard, TwoFactorGuard)
    @ApiBody({ type: WithdrawerRequestDto })
    @ApiBearerAuth("access-token")
    @Post("withdrawer-request")
    async withdrawerRequest(
        @Body() dto: WithdrawerRequestDto,
        @User() user: UserModel
    ) {
        return await this.tradingService.withdrawerRequest(user, dto);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Cancel withdrawal request within 6 seconds" })
    @UseGuards(AuthGuard)
    @ApiBearerAuth("access-token")
    @Post("cancel-withdrawer-request")
    async cancelWithdrawerRequest(
        @Body() dto: CancelWithdrawerRequestDto,
        @User() user: UserModel
    ) {
        return await this.tradingService.cancelWithdrawerRequest(user, dto);
    }
}
