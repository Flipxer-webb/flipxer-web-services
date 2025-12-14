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

@Controller("admin/operations/wallets")
@UseGuards(AuthGuard, RoleGuard, EnabledAccountGuard, PermissionGuard)
@UserTypes([UserType.ADMIN])
export class AdminWalletController {
    constructor(private readonly walletService: WalletManagementService) {}

    /**
     * Get all Quidax wallet balances (cached for 45s)
     */
    @Get()
    async getWalletBalances(
        @Query("refresh", new ParseBoolPipe({ optional: true })) refresh?: boolean
    ) {
        return this.walletService.getWalletBalances(refresh || false);
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
        if (!balance) {
            return { message: "Wallet not found", data: null };
        }
        return { data: balance };
    }

    /**
     * Get platform-wide wallet statistics
     */
    @Get("statistics")
    async getWalletStatistics() {
        return this.walletService.getWalletStatistics();
    }

    /**
     * Get liquidity thresholds configuration
     */
    @Get("thresholds")
    async getLiquidityThresholds() {
        return this.walletService.getLiquidityThresholds();
    }

    /**
     * Update liquidity thresholds
     */
    @Put("thresholds")
    async updateLiquidityThresholds(
        @Body() thresholds: LiquidityThreshold[],
        @User() user: UserModel
    ) {
        return this.walletService.updateLiquidityThresholds(thresholds, user.id);
    }

    /**
     * Check liquidity thresholds and return any breaches
     */
    @Get("thresholds/check")
    async checkLiquidityThresholds() {
        return this.walletService.checkLiquidityThresholds();
    }

    /**
     * Invalidate wallet cache
     */
    @Post("cache/invalidate")
    async invalidateCache() {
        await this.walletService.invalidateWalletCache();
        return { message: "Wallet cache invalidated successfully" };
    }
}
