import { buildResponse } from "@/utils/api-response-util";
import {
    settingsSecuritySendOtpRateLimit,
    settingsSecuritySendOtpWindowSeconds,
    settingsSecurityVerifyRateLimit,
    settingsSecurityVerifyWindowSeconds,
} from "@/config";
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
} from "@nestjs/common";

import { SettingService } from "../../services";
import { RateService } from "@/modules/api/trade/services/rate.service";
import {
    ApiTags,
    ApiOperation,
    ApiBearerAuth,
} from "@nestjs/swagger";
import {
    // AddAllowedIpDto,
    GetCryptoTransactionFeePerAssetDto,
    Enable2FADto,
    Disable2FADto,
    Verify2FACodeDto,
    UpdateSecurityPreferencesDto,
    SetTradingPasswordDto,
    VerifySecurityMethodDto,
    SendTransactionOtpDto,
    // UpdateAllowedIpDto,
} from "../../dtos";
import { AuthGuard, TwoFactorGuard } from "@/modules/api/auth/guard";
import { RateLimit, RateLimiterGuard } from "@/modules/core/rate-limit/guards/rate-limiter.guard";
import { User } from "@/modules/api/user/decorators";
import { User as UserModel } from "@prisma/client";

@ApiTags("settings")
@Controller({
    path: "settings",
})

export class SettingController {
    constructor(
        private readonly settingService: SettingService,
        private readonly rateService: RateService
    ) {}

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "get crypto rate list (dynamic)" })
    @Get("crypto/rates")
    async getCryptoRateList() {
        // Use dynamic rates from RateService
        const rates = await this.rateService.getAllRates();
        return buildResponse({
            message: "Crypto rate list retrieved",
            data: rates.map((rate) => ({
                id: 0, // Dynamic rates don't have DB id
                currency: rate.currency,
                buyRate: rate.buyRate,
                sellRate: rate.sellRate,
                createdAt: rate.lastUpdated || new Date(),
            })),
        });
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "get crypto rate per asset (dynamic)" })
    @Get("crypto/rates/:asset_name")
    async getCryptoRatePerAsset(@Param("asset_name") asset_name: string) {
        // Use dynamic rate from RateService
        const rate = await this.rateService.getAssetRate(asset_name);
        return buildResponse({
            message: "Crypto rate retrieved",
            data: {
                id: 0,
                currency: rate.currency,
                buyRate: rate.buyRate,
                sellRate: rate.sellRate,
                createdAt: rate.lastUpdated || new Date(),
            },
        });
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "get crypto transaction fee categories" })
    @Get("crypto/transaction-fee-categories")
    async getCryptoTransactionFeesCategories() {
        return this.settingService.getCryptoTransactionFeesCategories();
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "get crypto transaction fee list" })
    @Get("crypto/transaction-fees")
    async getCryptoTransactionFees() {
        return this.settingService.getCryptoTransactionFeeList();
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "get crypto transaction fee per asset" })
    @Get("crypto/transaction-fees/:asset_name")
    async getCryptoTransactionFeePerAsset(
        @Param("asset_name") asset_name: string,
        @Query() query: GetCryptoTransactionFeePerAssetDto
    ) {
        return this.settingService.getCryptoTransactionFeePerAsset(
            query,
            asset_name
        );
    }

    // @UseGuards(AuthGuard)
    // @ApiBearerAuth("access-token")
    // @HttpCode(HttpStatus.OK)
    // @ApiOperation({ summary: "get user allowed ip list" })
    // @Get("allowed-ips")
    // async getAllowedList(@User() user: UserModel) {
    //     return this.settingService.getAllowedList(user);
    // }

    // @HttpCode(HttpStatus.OK)
    // @UseGuards(AuthGuard)
    // @ApiBearerAuth("access-token")
    // @ApiOperation({ summary: "Add allowed ip" })
    // @Post("allowed-ips")
    // async addAllowedIp(@User() user: UserModel, @Body() dto: AddAllowedIpDto) {
    //     return this.settingService.addAllowedIp(user, dto);
    // }

    // @HttpCode(HttpStatus.OK)
    // @UseGuards(AuthGuard)
    // @ApiBearerAuth("access-token")
    // @ApiOperation({ summary: "update allowed ip" })
    // @Post("allowed-ips/:allowedIp")
    // async updateAllowedIp(
    //     @User() user: UserModel,
    //     @Param("allowedIp") allowedIp: string,
    //     @Body() dto: UpdateAllowedIpDto
    // ) {
    //     return this.settingService.updateAllowedIp(user, allowedIp, dto);
    // }

    // @HttpCode(HttpStatus.OK)
    // @UseGuards(AuthGuard)
    // @ApiBearerAuth("access-token")
    // @ApiOperation({ summary: "delete allowed ip" })
    // @Delete("allowed-ips/:allowedIpId")
    // async deleteCryptoRate(
    //     @User() user: UserModel,
    //     @Param("allowedIpId", ParseIntPipe) allowedIpId: number
    // ) {
    //     return this.settingService.deleteAllowedIp(user, allowedIpId);
    // }

    // ==================== Two-Factor Authentication ====================

    @UseGuards(AuthGuard, RateLimiterGuard)
    @ApiBearerAuth("access-token")
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Get 2FA status" })
    @Get("2fa/status")
    async get2FAStatus(@User() user: UserModel) {
        return this.settingService.get2FAStatus(user);
    }

    @UseGuards(AuthGuard, RateLimiterGuard)
    @ApiBearerAuth("access-token")
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Setup 2FA - Get QR code" })
    @Post("2fa/setup")
    async setup2FA(@User() user: UserModel) {
        return this.settingService.setup2FA(user);
    }

    @UseGuards(AuthGuard, RateLimiterGuard)
    @ApiBearerAuth("access-token")
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Enable 2FA" })
    @Post("2fa/enable")
    async enable2FA(@User() user: UserModel, @Body() dto: Enable2FADto) {
        return this.settingService.enable2FA(user, dto);
    }

    @UseGuards(AuthGuard, RateLimiterGuard)
    @ApiBearerAuth("access-token")
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Disable 2FA" })
    @Post("2fa/disable")
    async disable2FA(@User() user: UserModel, @Body() dto: Disable2FADto) {
        return this.settingService.disable2FA(user, dto);
    }

    @UseGuards(AuthGuard, RateLimiterGuard)
    @ApiBearerAuth("access-token")
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Verify 2FA code for transactions" })
    @Post("2fa/verify")
    async verify2FA(@User() user: UserModel, @Body() dto: Verify2FACodeDto) {
        return this.settingService.verify2FAForTransaction(user, dto);
    }

    // ==================== Security Preferences ====================

    @UseGuards(AuthGuard, RateLimiterGuard)
    @ApiBearerAuth("access-token")
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Get security preferences" })
    @Get("security/preferences")
    async getSecurityPreferences(@User() user: UserModel) {
        return this.settingService.getSecurityPreferences(user);
    }

    @UseGuards(AuthGuard, RateLimiterGuard)
    @ApiBearerAuth("access-token")
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Update security preferences" })
    @Post("security/preferences")
    async updateSecurityPreferences(
        @User() user: UserModel,
        @Body() dto: UpdateSecurityPreferencesDto
    ) {
        return this.settingService.updateSecurityPreferences(user, dto);
    }

    @UseGuards(AuthGuard, RateLimiterGuard)
    @ApiBearerAuth("access-token")
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Set or update trading password" })
    @Post("security/trading-password")
    async setTradingPassword(
        @User() user: UserModel,
        @Body() dto: SetTradingPasswordDto
    ) {
        return this.settingService.setTradingPassword(user, dto);
    }

    @UseGuards(AuthGuard, RateLimiterGuard, TwoFactorGuard)
    @ApiBearerAuth("access-token")
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Generate new backup codes" })
    @Post("security/backup-codes")
    async generateBackupCodes(@User() user: UserModel) {
        return this.settingService.generateNewBackupCodes(user);
    }

    @UseGuards(AuthGuard, RateLimiterGuard)
    @ApiBearerAuth("access-token")
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Get backup codes count" })
    @Get("security/backup-codes/count")
    async getBackupCodesCount(@User() user: UserModel) {
        return this.settingService.getBackupCodesCount(user);
    }

    @UseGuards(AuthGuard, RateLimiterGuard)
    @RateLimit({
        limit: settingsSecuritySendOtpRateLimit,
        windowSeconds: settingsSecuritySendOtpWindowSeconds,
        failOpen: false,
    })
    @ApiBearerAuth("access-token")
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Send transaction OTP via SMS or Email" })
    @Post("security/send-transaction-otp")
    async sendTransactionOtp(
        @User() user: UserModel,
        @Body() dto: SendTransactionOtpDto
    ) {
        return this.settingService.sendTransactionOtp(user, dto.method);
    }

    @UseGuards(AuthGuard, RateLimiterGuard)
    @RateLimit({
        limit: settingsSecurityVerifyRateLimit,
        windowSeconds: settingsSecurityVerifyWindowSeconds,
        failOpen: false,
    })
    @ApiBearerAuth("access-token")
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Verify security method (unified endpoint)" })
    @Post("security/verify")
    async verifySecurityMethod(
        @User() user: UserModel,
        @Body() dto: VerifySecurityMethodDto
    ) {
        const result = await this.settingService.verifySecurityMethod(user, dto);
        return {
            success: true,
            message: "Verification successful",
            data: result,
        };
    }

    @UseGuards(AuthGuard, RateLimiterGuard)
    @ApiBearerAuth("access-token")
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Get security requirements for transaction amount" })
    @Get("security/requirements")
    async getTransactionSecurityRequirements(
        @User() user: UserModel,
        @Query("amount") amount: string
    ) {
        return this.settingService.getTransactionSecurityRequirements(
            user,
            Number.parseFloat(amount) || 0
        );
    }
}
