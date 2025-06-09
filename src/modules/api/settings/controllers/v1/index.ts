import { SwaggerResponse, ApiResponse } from "@/utils/api-response-util";
import { Body, Controller, Get, HttpCode, HttpStatus } from "@nestjs/common";

import { SettingService } from "../../services";
import {
    ApiTags,
    ApiOperation,
    ApiResponse as SwaggerApiResponse,
} from "@nestjs/swagger";

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
    @ApiOperation({ summary: "get crypto transaction fee list" })
    @Get("crypto/transaction-fees")
    async getCryptoTransactionFees() {
        return this.settingService.getCryptoTransactionFeeList();
    }
}
