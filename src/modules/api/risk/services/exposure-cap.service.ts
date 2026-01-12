import { Injectable, Logger, Inject } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { WalletManagementService } from "@/modules/api/operations/services/wallet-management.service";
import { LiveCoinWatchService } from "@/modules/factory/trading/providers/livecoinwatch/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { OrderStatus } from "@prisma/client";

// Maximum allowable deficit in USD before blocking "Buy" orders
// This means the users can hold $50k more than the Master Wallet has before we stop selling.
const MAX_EXPOSURE_USD = 50000;

@Injectable()
export class ExposureCapService {
    private readonly logger = new Logger(ExposureCapService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly walletManagement: WalletManagementService,
        @Inject(TradingInjectionToken.LIVECOINWATCH)
        private readonly liveCoinWatch: LiveCoinWatchService
    ) { }

    /**
     * Checks if fulfilling a new Buy Order would breach the system's maximum exposure cap.
     * Exposure = (Total User Liabilities) - (Master Wallet Assets + Pending Sweeps)
     * 
     * @param currency The asset currency (e.g., 'BTC')
     * @param amount The amount the user wants to buy
     * @returns boolean - true if risk breached, false if safe
     */
    async isExposureBreached(currency: string, amount: number): Promise<boolean> {
        try {
            const symbol = currency.toUpperCase();

            // 1. Calculate Total User Liabilities for this Asset
            // Sum of all User AssetWallets (excluding admin/master if they track there)
            // Note: We assume Admin accounts might be excluded or insignificant for "User Liability" calculation
            const liabilitiesResult = await this.prisma.assetWallet.aggregate({
                where: {
                    assetCurrency: symbol,
                    user: { userType: { not: 'ADMIN' } } // Only count real user liabilities
                },
                _sum: {
                    balance: true
                }
            });
            let totalLiabilities = parseFloat(liabilitiesResult._sum.balance?.toString() || "0");

            // 1.5 Include "PENDING_LIQUIDITY_REVIEW" orders as liabilities
            // These are orders where we took the user's Fiat, but haven't credited their Crypto balance yet.
            // We owe them this crypto, so it counts as a liability.
            const pendingOrdersResult = await this.prisma.order.aggregate({
                where: {
                    currency: symbol,
                    status: OrderStatus.pending_liquidity_review
                },
                _sum: {
                    amount: true
                }
            });
            const pendingLiability = parseFloat(pendingOrdersResult._sum.amount?.toString() || "0");
            totalLiabilities += pendingLiability;

            // 2. Fetch Master Wallet Balance (Real Assets)
            const walletBalance = await this.walletManagement.getWalletBalance(symbol);
            const masterAssets = parseFloat(walletBalance?.availableBalance || "0");

            // 3. Fetch Pending Sweeps (Assets in Transit)
            // These are funds credited to users but not yet in Master Wallet.
            // We count them as "Assets" to prevents false positives.
            const pendingSweepsResult = await this.prisma.assetWallet.aggregate({
                where: { assetCurrency: symbol },
                _sum: { pendingSweepBalance: true } as any
            });
            const sumResult = pendingSweepsResult._sum as any;
            const totalPendingSweeps = parseFloat(sumResult?.pendingSweepBalance?.toString() || "0");

            // 4. Calculate Current System Deficit
            // Deficit = What we owe users - What we have (Master + Pending)
            // A positive number means we are short. Negative means we are over-collateralized.
            const currentDeficit = totalLiabilities - (masterAssets + totalPendingSweeps);

            // 5. Projected Deficit
            // If we sell 'amount' to user, we increase Liability by 'amount' (User balance up)
            // But we don't increase Assets (we just took Fiat).
            // So Deficit increases by 'amount'.
            const projectedDeficit = currentDeficit + amount;

            if (projectedDeficit <= 0) {
                // We are over-collateralized even after this trade. Safe.
                return false;
            }

            // 6. Convert Deficit to USD for standardization
            const priceInUsd = await this.liveCoinWatch.getPriceInUSD(symbol);
            if (!priceInUsd) {
                this.logger.warn(`Could not fetch price for ${symbol} to check exposure. Defaulting to SAFE mode.`);
                return false; // Fail open if price unavailable? Or close? defaulting to open for MVP to avoid blockage.
            }

            const deficitInUsd = projectedDeficit * priceInUsd;

            this.logger.debug(`Exposure Check [${symbol}]: Liabilities=${totalLiabilities}, Assets=${masterAssets}, Pending=${totalPendingSweeps}, Deficit=${projectedDeficit.toFixed(8)} (${deficitInUsd.toFixed(2)} USD)`);

            if (deficitInUsd > MAX_EXPOSURE_USD) {
                this.logger.warn(`EXPOSURE CAP BREACH: Projected Deficit $${deficitInUsd.toFixed(2)} exceeds limit $${MAX_EXPOSURE_USD}`);
                return true;
            }

            return false;

        } catch (error) {
            this.logger.error(`Failed to check exposure cap: ${error.message}`, error.stack);
            // In case of error, we default to allowing the trade to prevent downtime, 
            // but log significantly.
            return false;
        }
    }
}
