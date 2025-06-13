import { SwaggerResponse, ApiResponse } from "@/utils/api-response-util";
import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Query,
} from "@nestjs/common";

import { SettingService } from "../../services";
import {
    ApiTags,
    ApiOperation,
    ApiResponse as SwaggerApiResponse,
} from "@nestjs/swagger";
import { GetCryptoTransactionFeePerAssetDto } from "../../dtos";

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
}
