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
import { AuthGuard, CountryBlockGuard, TransactionAmountGuard } from "@/modules/api/auth/guard"; // Added TransactionAmountGuard
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { User } from "@/modules/api/user";
import { User as UserModel } from "@prisma/client";
import {
    BuyCryptoOrderDto,
    CancelWithdrawerRequestDto,
    ConfirmInstantSwapQuoteDto,
    GetCryptoWithdrawerFeeDto,
    GetWalletDto,
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
    constructor(private tradingService: TradingService) {}

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "get supported assets list" })
    @Get("supported-assets")
    async getSupportedAssets() {
        return this.tradingService.getSupportedAssets();
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "get supported payment methods" })
    @Get("supported-payment-methods")
    async getSupportedPaymentMethod(@Query() query: SupportedPaymentMethodDto) {
        return this.tradingService.getSupportedPaymentMethod(query);
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
    @ApiOperation({ summary: "get supported payment methods" })
    @Get("purchase-limits/buy")
    async getPurchaseLimitForBuy(@Query() query: PurchaseLimitBuyDto) {
        return this.tradingService.getPurchaseLimitForBuy(query);
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
        summary: "initiate wallet address generation",
    })
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
        summary: "initiate a buy order request",
    })
    @UseGuards(AuthGuard)
    @ApiBearerAuth("access-token")
    @Post("buy/quote")
    async buyCrypto(@Body() dto: InitiateBuyOrderDto, @User() user: UserModel) {
        return await this.tradingService.buyCryptoQuoteRequest(user, dto);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: "confirm buy order",
    })
    @UseGuards(AuthGuard, TransactionAmountGuard) // Added TransactionAmountGuard
    @ApiBearerAuth("access-token")
    @Post("buy/order")
    async buyCryptoOrder(
        @Body() dto: BuyCryptoOrderDto,
        @User() user: UserModel
    ) {
        return await this.tradingService.buyCryptoOrder(user, dto);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: "initiate a sell order request",
    })
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
        summary: "confirm sell order",
    })
    @UseGuards(AuthGuard, TransactionAmountGuard)
    @ApiBearerAuth("access-token")
    @Post("sell/order")
    async sellCryptoOrder(
        @Body() dto: SellCryptoOrderDto,
        @User() user: UserModel
    ) {
        return await this.tradingService.sellCryptoOrder(user, dto);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary:
            "endpoint is used to generate an instant swap quotation. Please note that the instant swap quotation is valid for only 15 seconds. To refresh the swap and obtain a new quotation, you can use the Refresh Instant Swap endpoint.",
    })
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
    @ApiOperation({
        summary: "endpoint is used to confirm an instant swap quotation",
    })
    @UseGuards(AuthGuard, TransactionAmountGuard)
    @ApiBearerAuth("access-token")
    @Post("confirm-instant-swap-quote")
    async confirmInstantSwapQuote(
        @Body() dto: ConfirmInstantSwapQuoteDto,
        @User() user: UserModel
    ) {
        return await this.tradingService.confirmInstantSwapQuote(user, dto);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: "endpoint is used to refresh an instant swap quotation",
    })
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
    @ApiOperation({
        summary:
            "This end point initiates the withdrawal - verify the details before proceeding with the withdrawal process. Once submitted, funds cannot be recovered if sent to an incorrect address.",
    })
    @UseGuards(AuthGuard, TransactionAmountGuard)
    @ApiBody({ type: WithdrawerRequestDto })
    @Post("withdrawer-request")
    async withdrawerRequest(
        @Body() dto: WithdrawerRequestDto,
        @User() user: UserModel
    ) {
        return await this.tradingService.withdrawerRequest(user, dto);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary:
            "users can cancel withdrawal requests within a 6-second window after initiating the withdrawal",
    })
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