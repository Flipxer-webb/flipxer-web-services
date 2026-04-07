import {
    Controller,
    Get,
    Put,
    Post,
    Body,
    Query,
    Param,
    UseGuards,
    ParseBoolPipe,
} from "@nestjs/common";
import { WalletManagementService } from "../../../services/wallet-management.service";
import { AuthGuard, EnabledAccountGuard } from "@/modules/api/auth/guard";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { PermissionGuard } from "@/modules/api/authorize/guards/permission.guard";
import { UserTypes, ADMIN_USER_TYPES, Permissions } from "@/modules/api/authorize/decorator";
import { PermissionName } from "@/modules/api/authorize/enums/role";
import { User } from "@/modules/api/user";
import { User as UserModel } from "@prisma/client";
import { LiquidityThreshold } from "../../../types";
import { buildResponse } from "@/utils/api-response-util";

@Controller("admin/wallets")
@UseGuards(AuthGuard, RoleGuard, EnabledAccountGuard, PermissionGuard)
@UserTypes(ADMIN_USER_TYPES)
export class AdminWalletController {
    constructor(private readonly walletService: WalletManagementService) {}

    /**
     * Get all Quidax wallet balances (cached for 45s)
     */
    @Permissions([PermissionName.SETTINGS_READ])
    @Get()
    async getWalletBalances(
        @Query("refresh", new ParseBoolPipe({ optional: true })) refresh?: boolean
    ) {
        const balances = await this.walletService.getWalletBalances(refresh || false);
        return buildResponse({
            message: "Wallet balances retrieved successfully",
            data: balances,
        });
    }

    /**
     * Get a specific wallet balance
     */
    @Permissions([PermissionName.SETTINGS_READ])
    @Get("balance/:currency")
    async getWalletBalance(
        @Param("currency") currency: string,
        @Query("refresh", new ParseBoolPipe({ optional: true })) refresh?: boolean
    ) {
        const balance = await this.walletService.getWalletBalance(currency, refresh || false);
        return buildResponse({
            message: balance ? "Wallet balance retrieved successfully" : "Wallet not found",
            data: balance,
        });
    }

    /**
     * Get platform-wide wallet statistics
     */
    @Permissions([PermissionName.SETTINGS_READ])
    @Get("statistics")
    async getWalletStatistics() {
        const statistics = await this.walletService.getWalletStatistics();
        return buildResponse({
            message: "Wallet statistics retrieved successfully",
            data: statistics,
        });
    }

    /**
     * Get liquidity thresholds configuration
     */
    @Permissions([PermissionName.SETTINGS_READ])
    @Get("thresholds")
    async getLiquidityThresholds() {
        const thresholds = await this.walletService.getLiquidityThresholds();
        return buildResponse({
            message: "Liquidity thresholds retrieved successfully",
            data: thresholds,
        });
    }

    /**
     * Update liquidity thresholds
     */
    @Permissions([PermissionName.SETTINGS_UPDATE])
    @Put("thresholds")
    async updateLiquidityThresholds(
        @Body() thresholds: LiquidityThreshold[],
        @User() user: UserModel
    ) {
        const result = await this.walletService.updateLiquidityThresholds(thresholds, user.id);
        return buildResponse({
            message: "Liquidity thresholds updated successfully",
            data: result,
        });
    }

    /**
     * Check liquidity thresholds and return any breaches
     */
    @Permissions([PermissionName.SETTINGS_READ])
    @Get("thresholds/check")
    async checkLiquidityThresholds() {
        const result = await this.walletService.checkLiquidityThresholds();
        return buildResponse({
            message: "Liquidity thresholds checked successfully",
            data: result,
        });
    }

    /**
     * Invalidate wallet cache
     */
    @Permissions([PermissionName.SETTINGS_UPDATE])
    @Post("cache/invalidate")
    async invalidateCache() {
        await this.walletService.invalidateWalletCache();
        return buildResponse({
            message: "Wallet cache invalidated successfully",
        });
    }
}
