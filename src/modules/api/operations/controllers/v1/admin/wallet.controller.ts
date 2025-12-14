import {
    Controller,
    Get,
    Put,
    Post,
    Body,
    Query,
    UseGuards,
    ParseBoolPipe,
} from "@nestjs/common";
import { WalletManagementService } from "../../../services/wallet-management.service";
import { JwtAuthGuard } from "@/modules/api/auth/guards";
import { RolesGuard } from "@/modules/api/rbac/guards";
import { Roles } from "@/modules/api/rbac/decorators";
import { CurrentUser } from "@/modules/api/auth/decorators";
import { User } from "@prisma/client";
import { LiquidityThreshold } from "../../../types";

@Controller("admin/operations/wallets")
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminWalletController {
    constructor(private readonly walletService: WalletManagementService) {}

    /**
     * Get all Quidax wallet balances (cached for 45s)
     */
    @Get()
    @Roles("view_wallets", "manage_wallets")
    async getWalletBalances(
        @Query("refresh", new ParseBoolPipe({ optional: true })) refresh?: boolean
    ) {
        return this.walletService.getWalletBalances(refresh || false);
    }

    /**
     * Get a specific wallet balance
     */
    @Get(":currency")
    @Roles("view_wallets", "manage_wallets")
    async getWalletBalance(
        @Query("currency") currency: string,
        @Query("refresh", new ParseBoolPipe({ optional: true })) refresh?: boolean
    ) {
        const balance = await this.walletService.getWalletBalance(currency, refresh || false);
        if (!balance) {
            return { message: "Wallet not found", data: null };
        }
        return { data: balance };
    }

    /**
     * Get platform-wide wallet statistics
     */
    @Get("statistics")
    @Roles("view_wallets", "manage_wallets", "view_analytics")
    async getWalletStatistics() {
        return this.walletService.getWalletStatistics();
    }

    /**
     * Get liquidity thresholds configuration
     */
    @Get("thresholds")
    @Roles("view_wallets", "manage_wallets")
    async getLiquidityThresholds() {
        return this.walletService.getLiquidityThresholds();
    }

    /**
     * Update liquidity thresholds
     */
    @Put("thresholds")
    @Roles("manage_wallets")
    async updateLiquidityThresholds(
        @Body() thresholds: LiquidityThreshold[],
        @CurrentUser() user: User
    ) {
        return this.walletService.updateLiquidityThresholds(thresholds, user.id);
    }

    /**
     * Check liquidity thresholds and return any breaches
     */
    @Get("thresholds/check")
    @Roles("view_wallets", "manage_wallets")
    async checkLiquidityThresholds() {
        return this.walletService.checkLiquidityThresholds();
    }

    /**
     * Invalidate wallet cache
     */
    @Post("cache/invalidate")
    @Roles("manage_wallets")
    async invalidateCache() {
        await this.walletService.invalidateWalletCache();
        return { message: "Wallet cache invalidated successfully" };
    }
}
