import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from "@nestjs/common";
import Redis from "ioredis";
import { redisConfig } from "@/config";

interface CacheEntry<T> {
    value: T;
    expiresAt: number;
}

@Injectable()
export class RedisCacheService implements OnModuleInit, OnModuleDestroy {
    private client: Redis;
    private readonly logger = new Logger(RedisCacheService.name);
    private isConnected = false;
    
    // In-memory fallback cache when Redis is unavailable
    private fallbackCache = new Map<string, CacheEntry<any>>();
    private fallbackCleanupInterval: NodeJS.Timeout;
    private readonly FALLBACK_ENABLED = true;
    private readonly MAX_FALLBACK_SIZE = 1000;

    onModuleInit() {
        this.client = new Redis({
            host: redisConfig.host,
            port: redisConfig.port,
            username: redisConfig.user,
            password: redisConfig.password,
            tls: redisConfig.redisOptions.tls,
            // Connection timeout - increased for remote Redis
            connectTimeout: 15000,
            commandTimeout: 10000,
            // Keep-alive to prevent idle disconnections
            keepAlive: 30000,
            // Enable offline queue to buffer commands during reconnection
            enableOfflineQueue: true,
            maxRetriesPerRequest: 3,
            // Retry strategy with exponential backoff
            retryStrategy: (times: number) => {
                if (times > 10) {
                    this.logger.error(`Redis cache: Max retries (${times}) exceeded`);
                    return null;
                }
                const delay = Math.min(Math.pow(2, times) * 100, 30000);
                this.logger.warn(`Redis cache: Retry ${times}, waiting ${delay}ms`);
                return delay;
            },
            reconnectOnError: (err: Error) => {
                if (err.message.includes("Too many requests") || err.message.includes("READONLY")) {
                    this.logger.warn("Redis cache: Reconnecting due to error: " + err.message);
                    return true;
                }
                return false;
            },
        });

        this.client.on("error", (err) => {
            this.isConnected = false;
            this.logger.error(`Redis cache error: ${err.message}`);
        });

        this.client.on("connect", () => {
            this.isConnected = true;
            this.logger.log("Redis cache connected");
        });

        this.client.on("close", () => {
            this.isConnected = false;
            this.logger.warn("Redis cache connection closed");
        });

        this.client.on("reconnecting", () => {
            this.logger.log("Redis cache reconnecting...");
        });

        // Cleanup expired entries from fallback cache every 60 seconds
        this.fallbackCleanupInterval = setInterval(() => {
            this.cleanupFallbackCache();
        }, 60000);
    }

    onModuleDestroy() {
        if (this.fallbackCleanupInterval) {
            clearInterval(this.fallbackCleanupInterval);
        }
        if (this.client) {
            this.client.disconnect();
        }
    }

    private cleanupFallbackCache(): void {
        const now = Date.now();
        let cleanedCount = 0;
        for (const [key, entry] of this.fallbackCache.entries()) {
            if (entry.expiresAt <= now) {
                this.fallbackCache.delete(key);
                cleanedCount++;
            }
        }
        if (cleanedCount > 0) {
            this.logger.debug(`Fallback cache: cleaned ${cleanedCount} expired entries`);
        }
    }

    private setFallback<T>(key: string, value: T, ttlSeconds: number): void {
        if (!this.FALLBACK_ENABLED) return;
        
        // Prevent cache from growing too large
        if (this.fallbackCache.size >= this.MAX_FALLBACK_SIZE) {
            // Remove oldest entries
            const keysToRemove = Array.from(this.fallbackCache.keys()).slice(0, 100);
            keysToRemove.forEach(k => this.fallbackCache.delete(k));
        }
        
        this.fallbackCache.set(key, {
            value,
            expiresAt: Date.now() + (ttlSeconds * 1000),
        });
    }

    private getFallback<T>(key: string): T | null {
        if (!this.FALLBACK_ENABLED) return null;
        
        const entry = this.fallbackCache.get(key);
        if (!entry) return null;
        
        if (entry.expiresAt <= Date.now()) {
            this.fallbackCache.delete(key);
            return null;
        }
        
        return entry.value as T;
    }

    async get<T = any>(key: string): Promise<T | null> {
        try {
            if (!this.isConnected) {
                this.logger.debug(`Redis unavailable, using fallback for GET: ${key}`);
                return this.getFallback<T>(key);
            }
            const value = await this.client.get(key);
            const parsed = value ? JSON.parse(value) : null;
            
            // Update fallback cache on successful read
            if (parsed && this.FALLBACK_ENABLED) {
                const ttl = await this.client.ttl(key);
                if (ttl > 0) {
                    this.setFallback(key, parsed, ttl);
                }
            }
            
            return parsed;
        } catch (error) {
            this.logger.error(`Redis GET error for ${key}: ${error.message}`);
            return this.getFallback<T>(key);
        }
    }

    async set(key: string, value: any, ttlSeconds: number): Promise<void> {
        // Always update fallback cache
        this.setFallback(key, value, ttlSeconds);
        
        try {
            if (!this.isConnected) {
                this.logger.debug(`Redis unavailable, using fallback for SET: ${key}`);
                return;
            }
            await this.client.set(key, JSON.stringify(value), "EX", ttlSeconds);
        } catch (error) {
            this.logger.error(`Redis SET error for ${key}: ${error.message}`);
            // Fallback is already set above
        }
    }

    async del(key: string): Promise<void> {
        // Always delete from fallback
        this.fallbackCache.delete(key);
        
        try {
            if (!this.isConnected) return;
            await this.client.del(key);
        } catch (error) {
            this.logger.error(`Redis DEL error for ${key}: ${error.message}`);
        }
    }

    async exists(key: string): Promise<boolean> {
        try {
            if (!this.isConnected) {
                return this.fallbackCache.has(key);
            }
            const exists = await this.client.exists(key);
            return exists === 1;
        } catch (error) {
            this.logger.error(`Redis EXISTS error for ${key}: ${error.message}`);
            return this.fallbackCache.has(key);
        }
    }

    /**
     * Health check for Redis connection
     */
    async isHealthy(): Promise<{ healthy: boolean; latencyMs?: number; usingFallback: boolean }> {
        const usingFallback = !this.isConnected;
        
        if (!this.isConnected) {
            return { 
                healthy: this.FALLBACK_ENABLED, 
                usingFallback: true 
            };
        }
        
        try {
            const start = Date.now();
            await this.client.ping();
            const latencyMs = Date.now() - start;
            return { healthy: true, latencyMs, usingFallback: false };
        } catch (error) {
            this.logger.error(`Redis health check failed: ${error.message}`);
            return { 
                healthy: this.FALLBACK_ENABLED, 
                usingFallback: true 
            };
        }
    }

    /**
     * Get cache statistics
     */
    getStats(): { fallbackSize: number; isConnected: boolean } {
        return {
            fallbackSize: this.fallbackCache.size,
            isConnected: this.isConnected,
        };
    }
}
