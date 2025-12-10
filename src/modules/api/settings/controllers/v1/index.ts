import { SwaggerResponse, ApiResponse } from "@/utils/api-response-util";
import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseIntPipe,
    Post,
    Query,
    UseGuards,
} from "@nestjs/common";

import { SettingService } from "../../services";
import {
    ApiTags,
    ApiOperation,
    ApiResponse as SwaggerApiResponse,
    ApiBearerAuth,
} from "@nestjs/swagger";
import {
    // AddAllowedIpDto,
    GetCryptoTransactionFeePerAssetDto,
    Enable2FADto,
    Disable2FADto,
    Verify2FACodeDto,
    // UpdateAllowedIpDto,
} from "../../dtos";
import { AuthGuard } from "@/modules/api/auth/guard";
import { User } from "@/modules/api/user";
import { User as UserModel } from "@prisma/client";

@ApiTags("settings")
@Controller({
    path: "settings",
})
export class SettingController {
    constructor(private settingService: SettingService) {}

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "get crypto rate list" })
    @Get("crypto/rates")
    async getCryptoRateList() {
        return this.settingService.getCryptoRateList();
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "get crypto rate per asset" })
    @Get("crypto/rates/:asset_name")
    async getCryptoRatePerAsset(@Param("asset_name") asset_name: string) {
        return this.settingService.getCryptoRatePerAsset(asset_name);
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

    @UseGuards(AuthGuard)
    @ApiBearerAuth("access-token")
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Get 2FA status" })
    @Get("2fa/status")
    async get2FAStatus(@User() user: UserModel) {
        return this.settingService.get2FAStatus(user);
    }

    @UseGuards(AuthGuard)
    @ApiBearerAuth("access-token")
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Setup 2FA - Get QR code" })
    @Post("2fa/setup")
    async setup2FA(@User() user: UserModel) {
        return this.settingService.setup2FA(user);
    }

    @UseGuards(AuthGuard)
    @ApiBearerAuth("access-token")
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Enable 2FA" })
    @Post("2fa/enable")
    async enable2FA(@User() user: UserModel, @Body() dto: Enable2FADto) {
        return this.settingService.enable2FA(user, dto);
    }

    @UseGuards(AuthGuard)
    @ApiBearerAuth("access-token")
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Disable 2FA" })
    @Post("2fa/disable")
    async disable2FA(@User() user: UserModel, @Body() dto: Disable2FADto) {
        return this.settingService.disable2FA(user, dto);
    }

    @UseGuards(AuthGuard)
    @ApiBearerAuth("access-token")
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Verify 2FA code for transactions" })
    @Post("2fa/verify")
    async verify2FA(@User() user: UserModel, @Body() dto: Verify2FACodeDto) {
        return this.settingService.verify2FAForTransaction(user, dto);
    }
}
