import { Injectable, Logger } from "@nestjs/common";
import { RedisCacheService } from "./redis-cache.service";

interface BankAccountCacheEntry {
    accountName: string;
    accountNumber: string;
    bankCode: string;
    cachedAt: number;
}

/**
 * Bank Account Verification Cache Service
 * 
 * Caches bank account verification results to reduce external API calls
 * to Fincra/Paystack. Bank account details rarely change, so we can
 * cache them for a reasonable period.
 * 
 * Cache key format: bank:verify:{bankCode}:{accountNumber}
 * TTL: 24 hours (bank account names don't change frequently)
 */
@Injectable()
export class BankCacheService {
    private readonly logger = new Logger(BankCacheService.name);
    
    // Cache TTL: 24 hours in seconds
    private readonly CACHE_TTL = 24 * 60 * 60;
    
    // Cache key prefix
    private readonly KEY_PREFIX = "bank:verify";

    constructor(private readonly cacheService: RedisCacheService) {}

    /**
     * Generate cache key for bank account verification
     */
    private getCacheKey(bankCode: string, accountNumber: string): string {
        return `${this.KEY_PREFIX}:${bankCode}:${accountNumber}`;
    }

    /**
     * Get cached bank account verification result
     * 
     * @param bankCode - Bank code (e.g., "057" for Zenith)
     * @param accountNumber - 10-digit NUBAN account number
     * @returns Cached result or null if not found/expired
     */
    async getCachedVerification(
        bankCode: string,
        accountNumber: string
    ): Promise<BankAccountCacheEntry | null> {
        try {
            const key = this.getCacheKey(bankCode, accountNumber);
            const cached = await this.cacheService.get<BankAccountCacheEntry>(key);
            
            if (cached) {
                this.logger.debug(
                    `Bank verification cache HIT: ${bankCode}:${accountNumber.slice(-4)}`
                );
                return cached;
            }
            
            this.logger.debug(
                `Bank verification cache MISS: ${bankCode}:${accountNumber.slice(-4)}`
            );
            return null;
        } catch (error) {
            this.logger.error(`Error getting cached bank verification: ${error.message}`);
            return null;
        }
    }

    /**
     * Cache a successful bank account verification result
     * 
     * @param bankCode - Bank code
     * @param accountNumber - Account number
     * @param accountName - Verified account name from bank
     */
    async cacheVerification(
        bankCode: string,
        accountNumber: string,
        accountName: string
    ): Promise<void> {
        try {
            const key = this.getCacheKey(bankCode, accountNumber);
            const entry: BankAccountCacheEntry = {
                accountName,
                accountNumber,
                bankCode,
                cachedAt: Date.now(),
            };
            
            await this.cacheService.set(key, entry, this.CACHE_TTL);
            
            this.logger.debug(
                `Cached bank verification: ${bankCode}:${accountNumber.slice(-4)} -> ${accountName}`
            );
        } catch (error) {
            this.logger.error(`Error caching bank verification: ${error.message}`);
            // Non-fatal - continue without caching
        }
    }

    /**
     * Invalidate cached bank account verification
     * Useful if a user reports incorrect account details
     * 
     * @param bankCode - Bank code
     * @param accountNumber - Account number
     */
    async invalidateCache(
        bankCode: string,
        accountNumber: string
    ): Promise<void> {
        try {
            const key = this.getCacheKey(bankCode, accountNumber);
            await this.cacheService.del(key);
            
            this.logger.debug(
                `Invalidated bank verification cache: ${bankCode}:${accountNumber.slice(-4)}`
            );
        } catch (error) {
            this.logger.error(`Error invalidating bank cache: ${error.message}`);
        }
    }

    /**
     * Get cache statistics (for monitoring)
     */
    async getCacheStats(): Promise<{
        prefix: string;
        ttlSeconds: number;
    }> {
        return {
            prefix: this.KEY_PREFIX,
            ttlSeconds: this.CACHE_TTL,
        };
    }
}
