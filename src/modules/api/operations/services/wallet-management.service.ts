import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { QuidaxLib } from "@/libs/quidax";
import { quidaxConfig } from "@/config";
import { 
    WalletBalance, 
    AggregatedWalletBalance,
    LiquidityThreshold 
} from "../types";

const WALLET_CACHE_KEY = "admin:quidax:wallets";
const WALLET_CACHE_TTL = 45; // 45 seconds as per Quidax rate limits

@Injectable()
export class WalletManagementService {
    private readonly logger = new Logger(WalletManagementService.name);
    private readonly quidax: QuidaxLib;

    constructor(
        private readonly prisma: PrismaService,
        private readonly cacheService: RedisCacheService,
    ) {
        this.quidax = new QuidaxLib({
            api_public: quidaxConfig.api_public,
            api_secret: quidaxConfig.api_secret,
            baseURL: quidaxConfig.baseUrl,
            rampBaseURL: quidaxConfig.rampBaseUrl,
        });
    }

    /**
     * Get all Quidax wallet balances with 45-second caching
     */
    async getWalletBalances(forceRefresh: boolean = false): Promise<AggregatedWalletBalance> {
        // Check cache first unless force refresh
        if (!forceRefresh) {
            const cached = await this.cacheService.get<AggregatedWalletBalance>(WALLET_CACHE_KEY);
            if (cached) {
                this.logger.debug("Returning cached wallet balances");
                return {
                    ...cached,
                    cachedAt: new Date(cached.cachedAt),
                    lastUpdated: new Date(cached.lastUpdated),
                };
            }
        }

        this.logger.log("Fetching fresh wallet balances from Quidax");

        try {
            // Fetch main account wallets from Quidax using "me" as user_id
            const walletsResponse = await this.quidax.getUserWalletList({ user_id: "me" });
            
            let wallets: WalletBalance[] = [];
            let totalValueNGN = 0;
            let totalValueUSD = 0;

            if (walletsResponse.data) {
                wallets = walletsResponse.data.map((wallet: any) => {
                    const balance = parseFloat(wallet.balance) || 0;
                    const locked = parseFloat(wallet.locked) || 0;
                    const staked = parseFloat(wallet.staked) || 0;
                    const availableBalance = balance - locked - staked;
                    
                    // Get converted balance in NGN (using Quidax's converted_balance if available)
                    const valueInNGN = parseFloat(wallet.converted_balance) || 0;
                    const valueInUSD = valueInNGN / 1600; // Approximate USD conversion

                    totalValueNGN += valueInNGN;
                    totalValueUSD += valueInUSD;

                    return {
                        currency: wallet.currency,
                        name: wallet.name || wallet.currency.toUpperCase(),
                        balance: wallet.balance,
                        locked: wallet.locked,
                        staked: wallet.staked,
                        availableBalance: availableBalance.toString(),
                        valueInNGN,
                        valueInUSD,
                        network: wallet.default_network || "N/A",
                        isCrypto: wallet.is_crypto !== false,
                    };
                });
            }

            const result: AggregatedWalletBalance = {
                totalValueNGN,
                totalValueUSD,
                wallets,
                lastUpdated: new Date(),
                cachedAt: new Date(),
            };

            // Cache the result for 45 seconds
            await this.cacheService.set(WALLET_CACHE_KEY, result, WALLET_CACHE_TTL);
            
            this.logger.log(`Cached ${wallets.length} wallet balances`);
            return result;
        } catch (error) {
            this.logger.error(`Failed to fetch wallet balances: ${error.message}`);
            
            // Try to return stale cache if available
            const staleCache = await this.cacheService.get<AggregatedWalletBalance>(WALLET_CACHE_KEY);
            if (staleCache) {
                this.logger.warn("Returning stale cached data due to API error");
                return {
                    ...staleCache,
                    cachedAt: new Date(staleCache.cachedAt),
                    lastUpdated: new Date(staleCache.lastUpdated),
                };
            }
            
            throw error;
        }
    }

    /**
     * Get wallet balance for a specific currency
     */
    async getWalletBalance(currency: string, forceRefresh: boolean = false): Promise<WalletBalance | null> {
        const allWallets = await this.getWalletBalances(forceRefresh);
        return allWallets.wallets.find(
            w => w.currency.toLowerCase() === currency.toLowerCase()
        ) || null;
    }

    /**
     * Check if any wallets breach liquidity thresholds
     */
    async checkLiquidityThresholds(): Promise<{ breaches: Array<{ wallet: WalletBalance; threshold: LiquidityThreshold; breachType: 'low' | 'high' }> }> {
        const thresholds = await this.getLiquidityThresholds();
        const wallets = await this.getWalletBalances();
        
        const breaches: Array<{ wallet: WalletBalance; threshold: LiquidityThreshold; breachType: 'low' | 'high' }> = [];

        for (const wallet of wallets.wallets) {
            const threshold = thresholds.find(
                t => t.currency.toLowerCase() === wallet.currency.toLowerCase()
            );

            if (threshold && threshold.alertEnabled) {
                const balance = parseFloat(wallet.availableBalance);
                
                if (balance < threshold.minBalance) {
                    breaches.push({ wallet, threshold, breachType: 'low' });
                } else if (balance > threshold.maxBalance && threshold.maxBalance > 0) {
                    breaches.push({ wallet, threshold, breachType: 'high' });
                }
            }
        }

        return { breaches };
    }

    /**
     * Get configured liquidity thresholds from system settings
     */
    async getLiquidityThresholds(): Promise<LiquidityThreshold[]> {
        const setting = await this.prisma.systemSetting.findUnique({
            where: { key: "liquidity_thresholds" },
        });

        if (!setting) {
            // Return default thresholds
            return [
                { currency: "btc", minBalance: 0.1, maxBalance: 10, alertEnabled: true },
                { currency: "eth", minBalance: 1, maxBalance: 100, alertEnabled: true },
                { currency: "usdt", minBalance: 10000, maxBalance: 1000000, alertEnabled: true },
                { currency: "usdc", minBalance: 10000, maxBalance: 1000000, alertEnabled: true },
            ];
        }

        return setting.value as unknown as LiquidityThreshold[];
    }

    /**
     * Update liquidity thresholds
     */
    async updateLiquidityThresholds(thresholds: LiquidityThreshold[], adminId: number): Promise<LiquidityThreshold[]> {
        await this.prisma.systemSetting.upsert({
            where: { key: "liquidity_thresholds" },
            update: {
                value: thresholds as any,
                updatedById: adminId,
            },
            create: {
                key: "liquidity_thresholds",
                value: thresholds as any,
                description: "Liquidity alert thresholds for crypto wallets",
                updatedById: adminId,
            },
        });

        return thresholds;
    }

    /**
     * Invalidate wallet cache (useful after manual operations)
     */
    async invalidateWalletCache(): Promise<void> {
        await this.cacheService.del(WALLET_CACHE_KEY);
        this.logger.log("Wallet cache invalidated");
    }

    /**
     * Get platform-wide wallet statistics
     */
    async getWalletStatistics(): Promise<{
        totalUsers: number;
        totalWallets: number;
        totalValueNGN: number;
        topCurrencies: Array<{ currency: string; totalBalance: number; userCount: number }>;
    }> {
        const [totalUsers, assetWalletStats] = await Promise.all([
            this.prisma.user.count({
                where: { userType: { not: "ADMIN" }, isDeleted: false },
            }),
            this.prisma.assetWallet.groupBy({
                by: ["assetCurrency"],
                _sum: { convertedBalance: true },
                _count: { userId: true },
            }),
        ]);

        const topCurrencies = assetWalletStats
            .map(stat => ({
                currency: stat.assetCurrency,
                totalBalance: stat._sum.convertedBalance?.toNumber() || 0,
                userCount: stat._count.userId,
            }))
            .sort((a, b) => b.totalBalance - a.totalBalance)
            .slice(0, 10);

        const totalValueNGN = topCurrencies.reduce((sum, c) => sum + c.totalBalance, 0);

        return {
            totalUsers,
            totalWallets: assetWalletStats.length,
            totalValueNGN,
            topCurrencies,
        };
    }
}
