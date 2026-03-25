/**
 * Rate Limiter Service
 * 
 * Handles rate limiting logic using Redis for distributed storage.
 * Implements a sliding window algorithm for accurate rate limiting.
 */

import { Injectable, Inject, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { redisConfig } from '@/config';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
  retryAfter?: number;
}

export interface RateLimitConfig {
  limit: number;
  windowSeconds: number;
  keyPrefix: string;
  failOpen?: boolean;
}

@Injectable()
export class RateLimiterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RateLimiterService.name);
  private readonly inMemoryStore = new Map<string, { count: number; resetTime: number }>();
  private client: Redis | null = null;
  private isRedisConnected = false;

  constructor(
    @Inject('RATE_LIMIT_OPTIONS')
    private readonly options: {
      limit: number;
      windowSeconds: number;
      useRedis: boolean;
      keyPrefix: string;
    },
  ) {}

  async onModuleInit() {
    if (this.options.useRedis) {
      try {
        this.client = new Redis({
          host: redisConfig.host,
          port: redisConfig.port,
          username: redisConfig.user,
          password: redisConfig.password,
          tls: redisConfig.redisOptions?.tls,
          connectTimeout: 5000,
          commandTimeout: 3000,
          retryStrategy: (times: number) => {
            if (times > 3) return null;
            return Math.min(times * 100, 3000);
          },
        });

        this.client.on('connect', () => {
          this.isRedisConnected = true;
          this.logger.log('Rate limiter connected to Redis');
        });

        this.client.on('error', (err) => {
          this.isRedisConnected = false;
          this.logger.warn(`Rate limiter Redis error: ${err.message}`);
        });
      } catch (error) {
        this.logger.warn(`Failed to connect to Redis for rate limiting: ${error.message}`);
      }
    }
  }

  async onModuleDestroy() {
    if (this.client) {
      await this.client.quit();
    }
  }

  /**
   * Check if a request is allowed under the rate limit
   * 
   * @param key - Unique identifier for the rate limit (e.g., IP address, user ID)
   * @param config - Optional override configuration
   */
  async checkLimit(
    key: string,
    config?: Partial<RateLimitConfig>,
  ): Promise<RateLimitResult> {
    const limit = config?.limit ?? this.options.limit;
    const windowSeconds = config?.windowSeconds ?? this.options.windowSeconds;
    const keyPrefix = config?.keyPrefix ?? this.options.keyPrefix;
    const fullKey = `${keyPrefix}${key}`;
    const failOpen = config?.failOpen ?? false;

    try {
      if (this.options.useRedis && this.client && this.isRedisConnected) {
        return await this.checkRedisLimit(fullKey, limit, windowSeconds);
      }
      return this.checkInMemoryLimit(fullKey, limit, windowSeconds);
    } catch (error) {
      this.logger.error(`SECURITY: Rate limit check failed for key ${key}:`, error);
      if (failOpen) {
        return { allowed: true, remaining: limit, resetTime: Date.now() + windowSeconds * 1000 };
      }
      return { allowed: false, remaining: 0, resetTime: Date.now() + windowSeconds * 1000, retryAfter: windowSeconds };
    }
  }

  /**
   * Redis-based rate limiting using sliding window
   */
  private async checkRedisLimit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = now - windowSeconds * 1000;
    const resetTime = now + windowSeconds * 1000;

    // Use Redis sorted set for sliding window
    const multi = this.client!.multi();
    
    // Remove old entries outside the window
    multi.zremrangebyscore(key, '-inf', windowStart);
    
    // Add current request with timestamp as score
    multi.zadd(key, now, `${now}-${Math.random()}`);
    
    // Count requests in window
    multi.zcard(key);
    
    // Set expiry on the key
    multi.expire(key, windowSeconds);

    const results = await multi.exec();
    
    if (!results) {
      throw new Error('Redis multi exec returned null');
    }

    const count = results[2]?.[1] as number ?? 0;
    const remaining = Math.max(0, limit - count);
    const allowed = count <= limit;

    return {
      allowed,
      remaining,
      resetTime,
      retryAfter: allowed ? undefined : windowSeconds,
    };
  }

  /**
   * In-memory rate limiting (fallback, not distributed)
   */
  private checkInMemoryLimit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): RateLimitResult {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    
    const record = this.inMemoryStore.get(key);

    if (!record || now > record.resetTime) {
      // New window
      this.inMemoryStore.set(key, {
        count: 1,
        resetTime: now + windowMs,
      });
      return {
        allowed: true,
        remaining: limit - 1,
        resetTime: now + windowMs,
      };
    }

    // Increment count
    record.count++;
    const remaining = Math.max(0, limit - record.count);
    const allowed = record.count <= limit;

    return {
      allowed,
      remaining,
      resetTime: record.resetTime,
      retryAfter: allowed ? undefined : Math.ceil((record.resetTime - now) / 1000),
    };
  }

  /**
   * Reset rate limit for a specific key
   */
  async resetLimit(key: string): Promise<void> {
    const fullKey = `${this.options.keyPrefix}${key}`;
    
    if (this.options.useRedis && this.client && this.isRedisConnected) {
      await this.client.del(fullKey);
    } else {
      this.inMemoryStore.delete(fullKey);
    }
  }

  /**
   * Get current rate limit status without incrementing
   */
  async getStatus(key: string): Promise<RateLimitResult | null> {
    const fullKey = `${this.options.keyPrefix}${key}`;
    
    if (this.options.useRedis && this.client && this.isRedisConnected) {
      const count = await this.client.zcard(fullKey);
      const ttl = await this.client.ttl(fullKey);
      
      if (count === 0) return null;
      
      return {
        allowed: count < this.options.limit,
        remaining: Math.max(0, this.options.limit - count),
        resetTime: Date.now() + ttl * 1000,
      };
    }
    
    const record = this.inMemoryStore.get(fullKey);
    if (!record) return null;
    
    return {
      allowed: record.count < this.options.limit,
      remaining: Math.max(0, this.options.limit - record.count),
      resetTime: record.resetTime,
    };
  }
}
