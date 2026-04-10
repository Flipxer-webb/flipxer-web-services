import { buildResponse } from "@/utils/api-response-util";
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
    Req,
    UseGuards,
} from "@nestjs/common";
import { Request } from "express";

import { SettingService } from "../../services";
import { RateService } from "@/modules/api/trade/services/rate.service";
import { AuditLogService } from "@/modules/api/audit-log";
import {
    ApiTags,
    ApiOperation,
    ApiBearerAuth,
} from "@nestjs/swagger";
import { AuthGuard, EnabledAccountGuard } from "@/modules/api/auth/guard";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { UserTypes, ADMIN_USER_TYPES, Permissions } from "@/modules/api/authorize/decorator";import { PermissionGuard } from "@/modules/api/authorize/guards/permission.guard";
import { PermissionName } from "@/modules/api/authorize/enums/role";
import {
    CreateOrUpdateCryptoRateDto,
    CreateOrUpdateCryptoTransactionFeeDto,
} from "../../dtos";

@ApiTags("admin")
@UseGuards(AuthGuard, RoleGuard, EnabledAccountGuard, PermissionGuard)
@UserTypes(ADMIN_USER_TYPES)
@ApiBearerAuth("access-token")
@Controller({
    path: "admin/settings",
})
export class AdminSettingController {
    constructor(
        private readonly settingService: SettingService,
        private readonly rateService: RateService,
        private readonly auditLogService: AuditLogService,
    ) {}

    @Permissions([PermissionName.SETTINGS_READ])
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "get crypto rate list" })
    @Get("crypto/rates")
    async getCryptoRateList() {
        return this.settingService.getCryptoRateList();
    }

    @Permissions([PermissionName.SETTINGS_READ])
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "get crypto transaction fee list" })
    @Get("crypto/transaction-fees")
    async getCryptoTransactionFees() {
        return this.settingService.getCryptoTransactionFeeList();
    }

    @Permissions([PermissionName.SETTINGS_UPDATE])
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "create or update crypto rate" })
    @Post("crypto/rates")
    async createOrUpdateCryptoRate(@Body() dto: CreateOrUpdateCryptoRateDto, @Req() req: Request) {
        const result = await this.settingService.createOrUpdateCryptoRate(dto);
        await this.auditLogService.log({
            action: "UPSERT_CRYPTO_RATE",
            resource: "crypto_rate",
            details: { ...dto },
            adminId: (req as any).user?.id,
            ipAddress: req.ip,
            userAgent: req.headers["user-agent"],
        });
        return result;
    }

    @Permissions([PermissionName.SETTINGS_UPDATE])
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "create or update crypto transaction fee" })
    @Post("crypto/transaction-fees")
    async createOrUpdateCryptoTransactionFee(
        @Body() dto: CreateOrUpdateCryptoTransactionFeeDto,
        @Req() req: Request
    ) {
        const result = await this.settingService.createOrUpdateCryptoTransactionFee(dto);
        await this.auditLogService.log({
            action: "UPSERT_CRYPTO_TRANSACTION_FEE",
            resource: "crypto_transaction_fee",
            details: { ...dto },
            adminId: (req as any).user?.id,
            ipAddress: req.ip,
            userAgent: req.headers["user-agent"],
        });
        return result;
    }

    @Permissions([PermissionName.SETTINGS_READ])
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "get crypto rate detail" })
    @Get("crypto/rates/:rateId")
    async getCryptoRateDetail(@Param("rateId", ParseIntPipe) rateId: number) {
        return this.settingService.getCryptoRateDetail(rateId);
    }

    @Permissions([PermissionName.SETTINGS_READ])
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

    @Permissions([PermissionName.SETTINGS_UPDATE])
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "delete crypto rate" })
    @Delete("crypto/rates/:rateId")
    async deleteCryptoRate(@Param("rateId", ParseIntPipe) rateId: number, @Req() req: Request) {
        const result = await this.settingService.deleteCryptoRate(rateId);
        await this.auditLogService.log({
            action: "DELETE_CRYPTO_RATE",
            resource: "crypto_rate",
            resourceId: rateId.toString(),
            adminId: (req as any).user?.id,
            ipAddress: req.ip,
            userAgent: req.headers["user-agent"],
        });
        return result;
    }

    @Permissions([PermissionName.SETTINGS_UPDATE])
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "delete crypto transaction fee" })
    @Delete("crypto/transaction-fees/:transactionFeeId")
    async deleteCryptoTransactionFee(
        @Param("transactionFeeId", ParseIntPipe) transactionFeeId: number,
        @Req() req: Request
    ) {
        const result = await this.settingService.deleteCryptoTransactionFee(transactionFeeId);
        await this.auditLogService.log({
            action: "DELETE_CRYPTO_TRANSACTION_FEE",
            resource: "crypto_transaction_fee",
            resourceId: transactionFeeId.toString(),
            adminId: (req as any).user?.id,
            ipAddress: req.ip,
            userAgent: req.headers["user-agent"],
        });
        return result;
    }

    // ============ Dynamic Rates Endpoints ============

    @Permissions([PermissionName.SETTINGS_READ])
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

    @Permissions([PermissionName.SETTINGS_READ])
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

    @Permissions([PermissionName.SETTINGS_UPDATE])
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Toggle dynamic rates feature on/off" })
    @Post("crypto/dynamic-rates/toggle")
    async toggleDynamicRates(@Body() dto: { enabled: boolean }, @Req() req: Request) {
        await this.rateService.setDynamicRatesEnabled(dto.enabled);
        await this.auditLogService.log({
            action: "TOGGLE_DYNAMIC_RATES",
            resource: "settings",
            details: { enabled: dto.enabled },
            adminId: (req as any).user?.id,
            ipAddress: req.ip,
            userAgent: req.headers["user-agent"],
        });
        return buildResponse({
            message: `Dynamic rates ${dto.enabled ? "enabled" : "disabled"}`,
            data: { enabled: dto.enabled },
        });
    }

    @Permissions([PermissionName.SETTINGS_UPDATE])
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Invalidate USDT rate cache (after admin updates USDT rate)" })
    @Post("crypto/dynamic-rates/invalidate-cache")
    async invalidateRateCache(@Req() req: Request) {
        await this.rateService.invalidateUsdtCache();
        await this.auditLogService.log({
            action: "INVALIDATE_RATE_CACHE",
            resource: "settings",
            adminId: (req as any).user?.id,
            ipAddress: req.ip,
            userAgent: req.headers["user-agent"],
        });
        return buildResponse({
            message: "USDT rate cache invalidated",
            data: null,
        });
    }
}
