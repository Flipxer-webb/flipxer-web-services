import { SwaggerResponse, ApiResponse, buildResponse } from "@/utils/api-response-util";
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
    UseGuards,
} from "@nestjs/common";

import { SettingService } from "../../services";
import { RateService } from "@/modules/api/trade/services/rate.service";
import {
    ApiTags,
    ApiOperation,
    ApiResponse as SwaggerApiResponse,
    ApiBearerAuth,
} from "@nestjs/swagger";
import { AuthGuard, EnabledAccountGuard } from "@/modules/api/auth/guard";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { UserTypes, ADMIN_USER_TYPES } from "@/modules/api/authorize/decorator";
import {
    CreateOrUpdateCryptoRateDto,
    CreateOrUpdateCryptoTransactionFeeDto,
} from "../../dtos";

@ApiTags("admin")
@UseGuards(AuthGuard, RoleGuard, EnabledAccountGuard)
@UserTypes(ADMIN_USER_TYPES)
@ApiBearerAuth("access-token")
@Controller({
    path: "admin/settings",
})
export class AdminSettingController {
    constructor(
        private settingService: SettingService,
        private rateService: RateService
    ) {}

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

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "create or update crypto rate" })
    @Post("crypto/rates")
    async createOrUpdateCryptoRate(@Body() dto: CreateOrUpdateCryptoRateDto) {
        return this.settingService.createOrUpdateCryptoRate(dto);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "create or update crypto transaction fee" })
    @Post("crypto/transaction-fees")
    async createOrUpdateCryptoTransactionFee(
        @Body() dto: CreateOrUpdateCryptoTransactionFeeDto
    ) {
        return this.settingService.createOrUpdateCryptoTransactionFee(dto);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "get crypto rate detail" })
    @Get("crypto/rates/:rateId")
    async getCryptoRateDetail(@Param("rateId", ParseIntPipe) rateId: number) {
        return this.settingService.getCryptoRateDetail(rateId);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "get crypto transaction fee detail" })
    @Get("crypto/transaction-fees/:transactionFeeId")
    async getCryptoTransactionFeeDetail(
        @Param("transactionFeeId", ParseIntPipe) transactionFeeId: number
    ) {
        return this.settingService.getCryptoTransactionFeeDetail(
            transactionFeeId
        );
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "delete crypto rate" })
    @Delete("crypto/rates/:rateId")
    async deleteCryptoRate(@Param("rateId", ParseIntPipe) rateId: number) {
        return this.settingService.deleteCryptoRate(rateId);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "delete crypto transaction fee" })
    @Delete("crypto/transaction-fees/:transactionFeeId")
    async deleteCryptoTransactionFee(
        @Param("transactionFeeId", ParseIntPipe) transactionFeeId: number
    ) {
        return this.settingService.deleteCryptoTransactionFee(transactionFeeId);
    }

    // ============ Dynamic Rates Endpoints ============

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Get calculated rates with dynamic pricing info" })
    @Get("crypto/calculated-rates")
    async getCalculatedRates() {
        const rates = await this.rateService.getAllRates();
        const status = await this.rateService.getStatus();
        return buildResponse({
            message: "Calculated rates retrieved",
            data: {
                isDynamic: status.isDynamic,
                usdtBaseRate: status.usdtRate,
                priceSource: status.priceSource,
                lastPriceUpdate: status.lastPriceUpdate,
                rates,
            },
        });
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Get dynamic rates feature status" })
    @Get("crypto/dynamic-rates/status")
    async getDynamicRatesStatus() {
        const status = await this.rateService.getStatus();
        return buildResponse({
            message: "Dynamic rates status retrieved",
            data: status,
        });
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Toggle dynamic rates feature on/off" })
    @Post("crypto/dynamic-rates/toggle")
    async toggleDynamicRates(@Body() dto: { enabled: boolean }) {
        await this.rateService.setDynamicRatesEnabled(dto.enabled);
        return buildResponse({
            message: `Dynamic rates ${dto.enabled ? "enabled" : "disabled"}`,
            data: { enabled: dto.enabled },
        });
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Invalidate USDT rate cache (after admin updates USDT rate)" })
    @Post("crypto/dynamic-rates/invalidate-cache")
    async invalidateRateCache() {
        await this.rateService.invalidateUsdtCache();
        return buildResponse({
            message: "USDT rate cache invalidated",
            data: null,
        });
    }
}
