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
} from "@nestjs/swagger";
import {
    AddAllowedIpDto,
    GetCryptoTransactionFeePerAssetDto,
    UpdateAllowedIpDto,
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

    @UseGuards(AuthGuard)
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "get user allowed ip list" })
    @Get("allowed-ips")
    async getAllowedList(@User() user: UserModel) {
        return this.settingService.getAllowedList(user);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Add allowed ip" })
    @Post("allowed-ips")
    async addAllowedIp(@User() user: UserModel, @Body() dto: AddAllowedIpDto) {
        return this.settingService.addAllowedIp(user, dto);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "delete allowed ip" })
    @Post("allowed-ips/:allowedIp")
    async updateAllowedIp(
        @User() user: UserModel,
        @Param("allowedIp") allowedIp: string,
        @Body() dto: UpdateAllowedIpDto
    ) {
        return this.settingService.updateAllowedIp(user, allowedIp, dto);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "delete allowed ip" })
    @Delete("allowed-ips/:allowedIp")
    async deleteCryptoRate(
        @User() user: UserModel,
        @Param("allowedIp", ParseIntPipe) allowedIp: number
    ) {
        return this.settingService.deleteAllowedIp(user, allowedIp);
    }

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
}
