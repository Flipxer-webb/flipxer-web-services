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
import { UserTypes } from "@/modules/api/authorize/decorator";
import { User } from "@/modules/api/user";
import { User as UserModel, UserType } from "@prisma/client";
import { LiquidityThreshold } from "../../../types";
import { buildResponse } from "@/utils/api-response-util";

@Controller("admin/wallets")
@UseGuards(AuthGuard, RoleGuard, EnabledAccountGuard, PermissionGuard)
@UserTypes([UserType.ADMIN, UserType.SUPER_ADMIN])
export class AdminWalletController {
    constructor(private readonly walletService: WalletManagementService) {}

    /**
     * Get all Quidax wallet balances (cached for 45s)
     */
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
    @Post("cache/invalidate")
    async invalidateCache() {
        await this.walletService.invalidateWalletCache();
        return buildResponse({
            message: "Wallet cache invalidated successfully",
        });
    }
}
