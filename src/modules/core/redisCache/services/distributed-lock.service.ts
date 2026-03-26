import { Injectable, Logger } from "@nestjs/common";
import Redis from "ioredis";
import { randomBytes } from "crypto";
import { redisConfig } from "@/config";

/**
 * Options for acquiring a distributed lock
 */
export interface LockOptions {
    /**
     * Time-to-live in milliseconds for the lock.
     * The lock will automatically expire after this time.
     * @default 30000 (30 seconds)
     */
    ttlMs?: number;

    /**
     * Maximum time to wait for acquiring the lock in milliseconds.
     * If the lock cannot be acquired within this time, an error is thrown.
     * @default 5000 (5 seconds)
     */
    maxWaitMs?: number;

    /**
     * Retry interval in milliseconds between lock acquisition attempts.
     * @default 100
     */
    retryIntervalMs?: number;

    /**
     * When true, throws an exception if Redis is unavailable instead of 
     * allowing the operation to proceed without a lock.
     * CRITICAL: Set to true for all financial/ledger operations.
     * @default false (for backward compatibility)
     */
    strict?: boolean;
}

/**
 * Distributed Lock Service
 * 
 * Provides Redis-based distributed locking to prevent race conditions
 * in webhook handlers and other concurrent operations.
 * 
 * Usage:
 * ```typescript
 * const result = await this.lockService.withLock(
 *     `deposit:${referenceId}`,
 *     async () => {
 *         // Critical section - only one process can execute this at a time
 *         return await this.processDeposit(data);
 *     },
 *     { ttlMs: 30000 }
 * );
 * ```
 */
@Injectable()
export class DistributedLockService {
    private client: Redis;
    private readonly logger = new Logger(DistributedLockService.name);
    private isConnected = false;

    // Default lock settings
    private readonly DEFAULT_TTL_MS = 30000;
    private readonly DEFAULT_MAX_WAIT_MS = 5000;
    private readonly DEFAULT_RETRY_INTERVAL_MS = 100;
    private readonly LOCK_PREFIX = "lock:";

    constructor() {
        this.initializeClient();
    }

    private initializeClient(): void {
        this.client = new Redis({
            host: redisConfig.host,
            port: redisConfig.port,
            username: redisConfig.user,
            password: redisConfig.password,
            tls: redisConfig.redisOptions.tls,
            connectTimeout: 15000,
            commandTimeout: 10000,
            keepAlive: 30000,
            enableOfflineQueue: false, // Locks should fail fast when disconnected
            maxRetriesPerRequest: 2,
            retryStrategy: (times: number) => {
                if (times > 5) {
                    this.logger.error(`Lock service: Max retries (${times}) exceeded`);
                    return null;
                }
                const delay = Math.min(Math.pow(2, times) * 100, 10000);
                return delay;
            },
        });

        this.client.on("error", (err) => {
            this.isConnected = false;
            this.logger.error(`Lock service error: ${err.message}`);
        });

        this.client.on("connect", () => {
            this.isConnected = true;
            this.logger.log("Lock service connected to Redis");
        });

        this.client.on("close", () => {
            this.isConnected = false;
            this.logger.warn("Lock service connection closed");
        });
    }

    /**
     * Attempts to acquire a lock for the given key.
     * 
     * @param key - Unique identifier for the lock
     * @param options - Lock acquisition options
     * @returns A unique token if lock acquired, null otherwise
     */
    async acquireLock(key: string, options: LockOptions = {}): Promise<string | null> {
        const {
            ttlMs = this.DEFAULT_TTL_MS,
            maxWaitMs = this.DEFAULT_MAX_WAIT_MS,
            retryIntervalMs = this.DEFAULT_RETRY_INTERVAL_MS,
            strict = false,
        } = options;

        const lockKey = `${this.LOCK_PREFIX}${key}`;
        const lockToken = `${Date.now()}-${randomBytes(16).toString('hex')}`;
        const startTime = Date.now();

        // do-while ensures at least one acquisition attempt even when maxWaitMs=0
        // (maxWaitMs=0 means "try once, don't wait if locked")
        do {
            try {
                if (!this.isConnected) {
                    if (strict) {
                        throw new Error(`Redis lock service unavailable - cannot proceed with lock for: ${key}`);
                    }
                    this.logger.warn(`Lock service unavailable, proceeding without lock for: ${key}`);
                    return lockToken; // Allow operation to proceed when Redis is down
                }

                // SET NX (only if not exists) with PX (expiry in milliseconds)
                const result = await this.client.set(
                    lockKey,
                    lockToken,
                    "PX",
                    ttlMs,
                    "NX"
                );

                if (result === "OK") {
                    this.logger.debug(`Lock acquired: ${key} (token: ${lockToken.substring(0, 8)}...)`);
                    return lockToken;
                }

                // Lock not acquired, wait and retry (skip sleep on last iteration)
                if (Date.now() - startTime < maxWaitMs) {
                    await this.sleep(retryIntervalMs);
                }
            } catch (error) {
                // Re-throw if it's our strict mode error
                if (error.message?.includes("Redis lock service unavailable")) {
                    throw error;
                }
                
                if (strict) {
                    throw new Error(`Redis lock error for ${key}: ${error.message}`);
                }
                
                this.logger.error(`Error acquiring lock for ${key}: ${error.message}`);
                // On error, allow operation to proceed (non-strict mode)
                return lockToken;
            }
        } while (Date.now() - startTime < maxWaitMs);

        this.logger.warn(`Failed to acquire lock for ${key} within ${maxWaitMs}ms`);
        return null;
    }

    /**
     * Releases a lock using the provided token.
     * Only releases if the token matches (prevents releasing someone else's lock).
     * 
     * @param key - The lock key
     * @param token - The token returned from acquireLock
     */
    async releaseLock(key: string, token: string): Promise<boolean> {
        const lockKey = `${this.LOCK_PREFIX}${key}`;

        try {
            if (!this.isConnected) {
                return true; // Consider it released if Redis is down
            }

            // Lua script to atomically check and delete
            const script = `
                if redis.call("get", KEYS[1]) == ARGV[1] then
                    return redis.call("del", KEYS[1])
                else
                    return 0
                end
            `;

            const result = await this.client.eval(script, 1, lockKey, token);
            const released = result === 1;

            if (released) {
                this.logger.debug(`Lock released: ${key}`);
            } else {
                this.logger.debug(`Lock not released (token mismatch or expired): ${key}`);
            }

            return released;
        } catch (error) {
            this.logger.error(`Error releasing lock for ${key}: ${error.message}`);
            return false;
        }
    }

    /**
     * Executes a function with a distributed lock.
     * Automatically acquires and releases the lock.
     * 
     * @param key - Unique identifier for the lock
     * @param fn - The function to execute while holding the lock
     * @param options - Lock acquisition options
     * @returns The result of the function, or throws if lock cannot be acquired
     */
    async withLock<T>(
        key: string,
        fn: () => Promise<T>,
        options: LockOptions = {}
    ): Promise<T> {
        const token = await this.acquireLock(key, options);

        if (!token) {
            throw new Error(`Failed to acquire lock for: ${key}`);
        }

        try {
            return await fn();
        } finally {
            await this.releaseLock(key, token);
        }
    }

    /**
     * Checks if a key is currently locked.
     * 
     * @param key - The key to check
     * @returns True if the key is locked
     */
    async isLocked(key: string): Promise<boolean> {
        const lockKey = `${this.LOCK_PREFIX}${key}`;

        try {
            if (!this.isConnected) {
                return false;
            }
            const exists = await this.client.exists(lockKey);
            return exists === 1;
        } catch (error) {
            this.logger.error(`Error checking lock status for ${key}: ${error.message}`);
            return false;
        }
    }

    /**
     * Gets the TTL (time-to-live) remaining on a lock in milliseconds.
     * 
     * @param key - The key to check
     * @returns TTL in milliseconds, or -1 if not found, -2 if no TTL
     */
    async getLockTTL(key: string): Promise<number> {
        const lockKey = `${this.LOCK_PREFIX}${key}`;

        try {
            if (!this.isConnected) {
                return -1;
            }
            return await this.client.pttl(lockKey);
        } catch (error) {
            this.logger.error(`Error getting lock TTL for ${key}: ${error.message}`);
            return -1;
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Cleanup on module destroy
     */
    async onModuleDestroy(): Promise<void> {
        if (this.client) {
            await this.client.quit();
        }
    }
}
