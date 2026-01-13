import { Injectable, Logger, Inject } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { CoinGeckoCacheService } from "@/modules/core/redisCache/services/coingecko-cache.service";
import { QuidaxLib } from "@/libs/quidax";
import { quidaxConfig } from "@/config";
import { 
    WalletBalance, 
    AggregatedWalletBalance,
    LiquidityThreshold 
} from "../types";

const WALLET_CACHE_KEY = "admin:quidax:wallets";
const WALLET_CACHE_TTL = 45; // 45 seconds as per Quidax rate limits
const NGN_USD_RATE_CACHE_KEY = "exchange:ngn:usd";
const NGN_USD_RATE_CACHE_TTL = 300; // 5 minutes

@Injectable()
export class WalletManagementService {
    private readonly logger = new Logger(WalletManagementService.name);
    private readonly quidax: QuidaxLib;

    constructor(
        private readonly prisma: PrismaService,
        private readonly cacheService: RedisCacheService,
        private readonly coinGeckoCache: CoinGeckoCacheService,
    ) {
        this.quidax = new QuidaxLib({
            api_public: quidaxConfig.api_public,
            api_secret: quidaxConfig.api_secret,
            baseURL: quidaxConfig.baseUrl,
            rampBaseURL: quidaxConfig.rampBaseUrl,
        });
    }

    /**
     * Get current NGN to USD exchange rate with caching
     * Falls back to a reasonable estimate if API fails
     */
    private async getNgnUsdRate(): Promise<number> {
        // Check cache first
        const cached = await this.cacheService.get<number>(NGN_USD_RATE_CACHE_KEY);
        if (cached) return cached;

        try {
            // Get USDT price in USD (should be ~1) and NGN
            // Then calculate NGN/USD rate from the crypto rates
            const usdtPriceUsd = await this.coinGeckoCache.getPriceInUSD("usdt");
            if (usdtPriceUsd) {
                // Get USDT/NGN rate from Quidax
                const marketData = await this.quidax.getSingleMarketTicker("usdtngn");
                const usdtNgnRate = parseFloat(marketData.data?.ticker?.last || "0");
                
                if (usdtNgnRate > 0) {
                    // NGN/USD = (USDT/USD) / (USDT/NGN)
                    const ngnUsdRate = usdtPriceUsd / usdtNgnRate;
                    await this.cacheService.set(NGN_USD_RATE_CACHE_KEY, ngnUsdRate, NGN_USD_RATE_CACHE_TTL);
                    this.logger.debug(`Calculated NGN/USD rate: ${ngnUsdRate} (1 NGN = $${ngnUsdRate})`);
                    return ngnUsdRate;
                }
            }
        } catch (error) {
            this.logger.warn(`Failed to fetch dynamic NGN/USD rate: ${error.message}`);
        }

        // Fallback to a reasonable estimate (will be updated on next successful call)
        const fallbackRate = 1 / 1600; // ~0.000625
        this.logger.warn(`Using fallback NGN/USD rate: ${fallbackRate}`);
        return fallbackRate;
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
                return cached;
            }
        }

        this.logger.log("Fetching fresh wallet balances from Quidax");

        try {
            // Fetch main account wallets from Quidax using "me" as user_id
            const walletsResponse = await this.quidax.getUserWalletList({ user_id: "me" });
            
            // Get dynamic NGN/USD rate
            const ngnUsdRate = await this.getNgnUsdRate();
            
            let wallets: WalletBalance[] = [];
            let totalNgnValue = 0;
            let totalUsdValue = 0;

            if (walletsResponse.data) {
                wallets = walletsResponse.data.map((wallet: any) => {
                    const balance = parseFloat(wallet.balance) || 0;
                    const locked = parseFloat(wallet.locked) || 0;
                    const staked = parseFloat(wallet.staked) || 0;
                    const availableBalance = balance - locked - staked;
                    
                    // Get converted balance in NGN (using Quidax's converted_balance if available)
                    const ngnValue = parseFloat(wallet.converted_balance) || 0;
                    // Use dynamic NGN/USD rate instead of hardcoded value
                    const usdValue = ngnValue * ngnUsdRate;

                    totalNgnValue += ngnValue;
                    totalUsdValue += usdValue;

                    return {
                        currency: wallet.currency,
                        name: wallet.name || wallet.currency.toUpperCase(),
                        balance: wallet.balance,
                        availableBalance: availableBalance.toString(),
                        lockedBalance: wallet.locked,
                        ngnValue,
                        usdValue,
                        network: wallet.default_network || "N/A",
                        isCrypto: wallet.is_crypto !== false,
                    };
                });
            }

            const result: AggregatedWalletBalance = {
                totalNgnValue,
                totalUsdValue,
                wallets,
                lastUpdated: new Date().toISOString(),
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
                return staleCache;
            }
            
            // Return empty wallet data instead of throwing to gracefully handle Quidax unavailability
            this.logger.warn("No cached data available, returning empty wallet data");
            return {
                totalNgnValue: 0,
                totalUsdValue: 0,
                wallets: [],
                lastUpdated: new Date().toISOString(),
                error: "Failed to fetch wallet data. Please ensure Quidax credentials are configured.",
            };
        }
    }

    /**
     * Invalidate the wallet balance cache to force a refresh on next request
     */
    async invalidateWalletCache(): Promise<void> {
        await this.cacheService.del(WALLET_CACHE_KEY);
        this.logger.log("Invalidated wallet balance cache");
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
            // Return default thresholds with float configuration
            return [
                { currency: "btc", minBalance: 0.1, maxBalance: 10, alertEnabled: true, floatPercentage: 20, absoluteReserve: 0.01 },
                { currency: "eth", minBalance: 1, maxBalance: 100, alertEnabled: true, floatPercentage: 20, absoluteReserve: 0.1 },
                { currency: "usdt", minBalance: 10000, maxBalance: 1000000, alertEnabled: true, floatPercentage: 20, absoluteReserve: 1000 },
                { currency: "usdc", minBalance: 10000, maxBalance: 1000000, alertEnabled: true, floatPercentage: 20, absoluteReserve: 1000 },
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
