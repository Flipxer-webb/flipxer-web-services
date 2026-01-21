import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from "@nestjs/common";
import Redis from "ioredis";
import { redisConfig } from "@/config";

interface CacheEntry<T> {
    value: T;
    expiresAt: number;
}

@Injectable()
export class RedisCacheService implements OnModuleInit, OnModuleDestroy {
    private client: Redis | null = null;
    private readonly logger = new Logger(RedisCacheService.name);
    private isConnected = false;

    // In-memory fallback cache when Redis is unavailable
    private fallbackCache = new Map<string, CacheEntry<any>>();
    private fallbackCleanupInterval: NodeJS.Timeout;
    private readonly FALLBACK_ENABLED = true;
    private readonly MAX_FALLBACK_SIZE = 1000;

    // Circuit breaker: Skip Redis for 30s after failure
    private lastFailureTime = 0;
    private readonly CIRCUIT_BREAKER_DURATION_MS = 30000;
    private consecutiveFailures = 0;
    private readonly MAX_CONSECUTIVE_FAILURES = 3;

    // Check if Redis is disabled via environment variable
    private readonly REDIS_DISABLED = process.env.REDIS_DISABLED === "true";

    onModuleInit() {
        // If Redis is disabled, don't even try to connect
        if (this.REDIS_DISABLED) {
            this.logger.log("Redis DISABLED via environment variable - using in-memory cache only");
            // Start fallback cache cleanup interval
            this.fallbackCleanupInterval = setInterval(() => {
                this.cleanupFallbackCache();
            }, 60000);
            return;
        }

        this.client = new Redis({
            host: redisConfig.host,
            port: redisConfig.port,
            username: redisConfig.user,
            password: redisConfig.password,
            tls: redisConfig.redisOptions.tls,
            // AGGRESSIVE TIMEOUTS: Fail fast to use in-memory fallback
            connectTimeout: 2000,   // 2 seconds to connect (was 5s)
            commandTimeout: 500,    // 500ms command timeout (was 3s) - fail fast!
            // Keep-alive to prevent idle disconnections
            keepAlive: 30000,
            // DISABLE offline queue - fail immediately if not connected
            enableOfflineQueue: false,
            maxRetriesPerRequest: 1,  // Reduced from 3
            // Retry strategy with fast backoff
            retryStrategy: (times: number) => {
                if (times > 5) {
                    this.logger.error(`Redis cache: Max retries (${times}) exceeded, using fallback`);
                    return null;
                }
                const delay = Math.min(times * 200, 2000); // Max 2s delay
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

    /**
     * Check if circuit breaker is open (Redis should be skipped)
     */
    private isCircuitBreakerOpen(): boolean {
        if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
            const timeSinceLastFailure = Date.now() - this.lastFailureTime;
            if (timeSinceLastFailure < this.CIRCUIT_BREAKER_DURATION_MS) {
                return true; // Circuit is open, skip Redis
            }
            // Circuit breaker timeout expired, try Redis again
            this.consecutiveFailures = 0;
        }
        return false;
    }

    private recordFailure(): void {
        this.consecutiveFailures++;
        this.lastFailureTime = Date.now();
        if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
            this.logger.warn(`[PERF] Circuit breaker OPEN: Skipping Redis for ${this.CIRCUIT_BREAKER_DURATION_MS / 1000}s`);
        }
    }

    private recordSuccess(): void {
        if (this.consecutiveFailures > 0) {
            this.logger.log(`[PERF] Redis recovered, closing circuit breaker`);
        }
        this.consecutiveFailures = 0;
    }

    async get<T = any>(key: string): Promise<T | null> {
        // If Redis is disabled, use fallback only
        if (this.REDIS_DISABLED || !this.client) {
            return this.getFallback<T>(key);
        }

        // Circuit breaker: Skip Redis if it's been failing
        if (this.isCircuitBreakerOpen()) {
            return this.getFallback<T>(key);
        }

        try {
            if (!this.isConnected) {
                this.logger.debug(`Redis unavailable, using fallback for GET: ${key}`);
                return this.getFallback<T>(key);
            }
            const value = await this.client.get(key);
            const parsed = value ? JSON.parse(value) : null;

            // Record success and update fallback cache
            this.recordSuccess();
            if (parsed && this.FALLBACK_ENABLED) {
                const ttl = await this.client.ttl(key);
                if (ttl > 0) {
                    this.setFallback(key, parsed, ttl);
                }
            }

            return parsed;
        } catch (error) {
            this.recordFailure();
            this.logger.error(`Redis GET error for ${key}: ${error.message}`);
            return this.getFallback<T>(key);
        }
    }

    async getDel<T = any>(key: string): Promise<T | null> {
        // Fallback implementation
        if (this.REDIS_DISABLED || !this.client) {
            const value = this.getFallback<T>(key);
            if (value) this.fallbackCache.delete(key);
            return value;
        }

        if (this.isCircuitBreakerOpen()) {
            const value = this.getFallback<T>(key);
            if (value) this.fallbackCache.delete(key);
            return value;
        }

        try {
            if (!this.isConnected) {
                const value = this.getFallback<T>(key);
                if (value) this.fallbackCache.delete(key);
                return value;
            }

            // Use multi to ensure atomicity (GET + DEL)
            // This is equivalent to GETDEL but works with older Redis versions too
            const results = await this.client.multi().get(key).del(key).exec();

            // results[0] is [error, result] for the get command
            const getError = results?.[0]?.[0];
            const getValue = results?.[0]?.[1] as string | null;

            if (getError) throw getError;

            const parsed = getValue ? JSON.parse(getValue) : null;

            this.recordSuccess();
            // Also remove from fallback to keep consistent
            this.fallbackCache.delete(key);

            return parsed;
        } catch (error) {
            this.recordFailure();
            this.logger.error(`Redis GETDEL error for ${key}: ${error.message}`);
            // Fallback attempt
            const value = this.getFallback<T>(key);
            if (value) this.fallbackCache.delete(key);
            return value;
        }
    }

    async set(key: string, value: any, ttlSeconds: number): Promise<void> {
        // Always update fallback cache
        this.setFallback(key, value, ttlSeconds);

        // If Redis is disabled, skip Redis operations
        if (this.REDIS_DISABLED || !this.client) {
            return;
        }

        // Circuit breaker: Skip Redis if it's been failing
        if (this.isCircuitBreakerOpen()) {
            return;
        }

        try {
            if (!this.isConnected) {
                this.logger.debug(`Redis unavailable, using fallback for SET: ${key}`);
                return;
            }
            await this.client.set(key, JSON.stringify(value), "EX", ttlSeconds);
            this.recordSuccess();
        } catch (error) {
            this.recordFailure();
            this.logger.error(`Redis SET error for ${key}: ${error.message}`);
            // Fallback is already set above
        }
    }

    async del(key: string): Promise<void> {
        // Always delete from fallback
        this.fallbackCache.delete(key);

        // If Redis is disabled, skip Redis operations
        if (this.REDIS_DISABLED || !this.client) {
            return;
        }

        try {
            if (!this.isConnected) return;
            await this.client.del(key);
        } catch (error) {
            this.logger.error(`Redis DEL error for ${key}: ${error.message}`);
        }
    }

    async exists(key: string): Promise<boolean> {
        // If Redis is disabled, check fallback only
        if (this.REDIS_DISABLED || !this.client) {
            return this.fallbackCache.has(key);
        }

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

    // ==================== Atomic Counter Operations ====================

    /**
     * Atomically increment a float value and return the new total.
     * If key doesn't exist, initializes to 0 before incrementing.
     * 
     * Used for rate limiting (transaction limits) where atomicity is critical.
     * 
     * @param key - Redis key to increment
     * @param increment - Amount to add (can be negative for decrement)
     * @param ttlSeconds - Optional TTL to set if key is newly created
     * @returns The new value after increment, or null if Redis unavailable (signals DB fallback needed)
     */
    async incrbyfloat(key: string, increment: number, ttlSeconds?: number): Promise<number | null> {
        // If Redis is disabled or unavailable, return null to signal caller should use DB fallback
        if (this.REDIS_DISABLED || !this.client) {
            this.logger.debug(`Redis unavailable for INCRBYFLOAT on ${key} - signaling DB fallback`);
            return null;
        }

        if (this.isCircuitBreakerOpen()) {
            this.logger.debug(`Circuit breaker open for INCRBYFLOAT on ${key} - signaling DB fallback`);
            return null;
        }

        try {
            if (!this.isConnected) {
                this.logger.debug(`Redis not connected for INCRBYFLOAT on ${key} - signaling DB fallback`);
                return null;
            }

            // INCRBYFLOAT is atomic - perfect for rate limiting
            const result = await this.client.incrbyfloat(key, increment);
            const newValue = parseFloat(result);

            // Set TTL if this is a new key (value equals increment means it was just created)
            if (ttlSeconds && Math.abs(newValue - increment) < 0.001) {
                await this.client.expire(key, ttlSeconds);
                this.logger.debug(`Set TTL ${ttlSeconds}s for new limit key: ${key}`);
            }

            this.recordSuccess();
            return newValue;
        } catch (error) {
            this.recordFailure();
            this.logger.error(`Redis INCRBYFLOAT error for ${key}: ${error.message}`);
            return null; // Signal caller to use DB fallback
        }
    }

    /**
     * Atomically decrement a float value (rollback an increment).
     * Convenience wrapper around incrbyfloat with negative value.
     * 
     * @param key - Redis key to decrement
     * @param decrement - Amount to subtract (positive number)
     * @returns The new value after decrement, or null if Redis unavailable
     */
    async decrbyfloat(key: string, decrement: number): Promise<number | null> {
        return this.incrbyfloat(key, -Math.abs(decrement));
    }

    /**
     * Get the current value of a counter without modifying it.
     * Returns 0 if key doesn't exist, null if Redis unavailable.
     * 
     * @param key - Redis key to read
     * @returns Current value, 0 if not exists, or null if Redis unavailable
     */
    async getCounter(key: string): Promise<number | null> {
        if (this.REDIS_DISABLED || !this.client || this.isCircuitBreakerOpen()) {
            return null;
        }

        try {
            if (!this.isConnected) return null;

            const value = await this.client.get(key);
            this.recordSuccess();
            return value ? parseFloat(value) : 0;
        } catch (error) {
            this.recordFailure();
            this.logger.error(`Redis GET counter error for ${key}: ${error.message}`);
            return null;
        }
    }
}
