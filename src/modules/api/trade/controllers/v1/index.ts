import { SwaggerResponse, ApiResponse } from "@/utils/api-response-util";
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
import {
    ApiTags,
    ApiOperation,
    ApiBearerAuth,
    ApiBody,
    ApiResponse as SwaggerApiResponse,
} from "@nestjs/swagger";
import {
    AuthGuard,
    CountryBlockGuard,
    TransactionAmountGuard,
} from "@/modules/api/auth/guard";
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
    @ApiOperation({ summary: "Get supported assets list" })
    @Get("supported-assets")
    async getSupportedAssets() {
        return this.tradingService.getSupportedAssets();
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Get supported payment methods" })
    @Get("supported-payment-methods")
    async getSupportedPaymentMethod(@Query() query: SupportedPaymentMethodDto) {
        return this.tradingService.getSupportedPaymentMethod(query);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Get supported network list" })
    @Get("supported-networks")
    async getSupportedNetworks() {
        return this.tradingService.getSupportedNetworks();
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Get supported trading pair list" })
    @Get("supported-trading-pairs")
    async getSupportedTradingPairs() {
        return this.tradingService.getSupportedTradingPairs();
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Get supported payment methods" })
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
    @ApiOperation({ summary: "Get crypto withdrawer fee" })
    @Get("withdrawer-fee")
    async getWithdrawerFee(@Query() dto: GetCryptoWithdrawerFeeDto) {
        return this.tradingService.getCryptoWithdrawerFee(dto);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Get wallet info for the authenticated user" })
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
            "Initiate wallet address generation for the authenticated user",
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
            "Manually trigger crypto account creation for users who missed auto-generation",
    })
    @UseGuards(AuthGuard)
    @ApiBearerAuth("access-token")
    @Post("crypto-account-creation-manual-trigger")
    async triggerQuidaxAccountCreation(@User() user: UserModel) {
        return await this.tradingService.triggerQuidaxAccountCreation(user);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary:
            "Initiate a buy order request. If the user is flagged, the transaction is blocked, recorded as failed with a unique transaction ID, and an email is sent prompting the user to contact support. If the transaction exceeds the daily limit ($5,000 for individuals, $10,000 for others) or monthly limit ($100,000 for individuals, $500,000 for others), it is blocked, recorded as failed, and for monthly limit violations, the user is flagged and an email is sent.",
    })
    @UseGuards(AuthGuard, TransactionAmountGuard)
    @ApiBearerAuth("access-token")
    @Post("buy/quote")
    async buyCrypto(@Body() dto: InitiateBuyOrderDto, @User() user: UserModel) {
        return await this.tradingService.buyCryptoQuoteRequest(user, dto);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary:
            "Confirm a buy order. If the user is flagged, the transaction is blocked, recorded as failed with a unique transaction ID, and an email is sent prompting the user to contact support. If the transaction exceeds the daily limit ($5,000 for individuals, $10,000 for others) or monthly limit ($100,000 for individuals, $500,000 for others), it is blocked, recorded as failed, and for monthly limit violations, the user is flagged and an email is sent.",
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
    @ApiOperation({
        summary:
            "Initiate a sell order request. If the user is flagged, the transaction is blocked, recorded as failed with a unique transaction ID, and an email is sent prompting the user to contact support. If the transaction exceeds the daily limit ($5,000 for individuals, $10,000 for others) or monthly limit ($100,000 for individuals, $500,000 for others), it is blocked, recorded as failed, and for monthly limit violations, the user is flagged and an email is sent.",
    })
    @UseGuards(AuthGuard, TransactionAmountGuard)
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
            "Confirm a sell order. If the user is flagged, the transaction is blocked, recorded as failed with a unique transaction ID, and an email is sent prompting the user to contact support. If the transaction exceeds the daily limit ($5,000 for individuals, $10,000 for others) or monthly limit ($100,000 for individuals, $500,000 for others), it is blocked, recorded as failed, and for monthly limit violations, the user is flagged and an email is sent.",
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
            "Generate an instant swap quotation, valid for 15 seconds. If the user is flagged, the transaction is blocked, recorded as failed with a unique transaction ID, and an email is sent prompting the user to contact support. If the transaction exceeds the daily limit ($5,000 for individuals, $10,000 for others) or monthly limit ($100,000 for individuals, $500,000 for others), it is blocked, recorded as failed, and for monthly limit violations, the user is flagged and an email is sent. Use the Refresh Instant Swap endpoint to obtain a new quotation.",
    })
    @UseGuards(AuthGuard, TransactionAmountGuard)
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
        summary: "Confirm an instant swap quotation",
    })
    @UseGuards(AuthGuard)
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
        summary:
            "Refresh an instant swap quotation. If the user is flagged, the transaction is blocked, recorded as failed with a unique transaction ID, and an email is sent prompting the user to contact support. If the transaction exceeds the daily limit ($5,000 for individuals, $10,000 for others) or monthly limit ($100,000 for individuals, $500,000 for others), it is blocked, recorded as failed, and for monthly limit violations, the user is flagged and an email is sent.",
    })
    @UseGuards(AuthGuard, TransactionAmountGuard)
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
            "Initiate a withdrawal. Verify details before proceeding, as funds cannot be recovered if sent to an incorrect address. If the user is flagged, the transaction is blocked, recorded as failed with a unique transaction ID, and an email is sent prompting the user to contact support. If the transaction exceeds the daily limit ($5,000 for individuals, $10,000 for others) or monthly limit ($100,000 for individuals, $500,000 for others), it is blocked, recorded as failed, and for monthly limit violations, the user is flagged and an email is sent.",
    })
    @UseGuards(AuthGuard, TransactionAmountGuard)
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
    @ApiOperation({
        summary:
            "Cancel a withdrawal request within a 6-second window after initiation",
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
