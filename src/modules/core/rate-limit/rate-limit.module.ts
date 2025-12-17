/**
 * Rate Limiting Module
 * 
 * Provides configurable rate limiting for API endpoints to prevent abuse.
 * Uses Redis for distributed rate limiting across multiple instances.
 */

import { Module, DynamicModule, Global } from '@nestjs/common';
import { RateLimiterService } from './services/rate-limiter.service';
import { RateLimiterGuard } from './guards/rate-limiter.guard';
import { RateLimitInterceptor } from './interceptors/rate-limit.interceptor';

export interface RateLimitModuleOptions {
  /**
   * Maximum number of requests allowed in the time window
   */
  limit?: number;
  
  /**
   * Time window in seconds
   */
  windowSeconds?: number;
  
  /**
   * Whether to use Redis for distributed rate limiting
   */
  useRedis?: boolean;
  
  /**
   * Custom key prefix for rate limit storage
   */
  keyPrefix?: string;
}

@Global()
@Module({})
export class RateLimitModule {
  static forRoot(options: RateLimitModuleOptions = {}): DynamicModule {
    return {
      module: RateLimitModule,
      providers: [
        {
          provide: 'RATE_LIMIT_OPTIONS',
          useValue: {
            limit: options.limit ?? 100,
            windowSeconds: options.windowSeconds ?? 60,
            useRedis: options.useRedis ?? true,
            keyPrefix: options.keyPrefix ?? 'ratelimit:',
          },
        },
        RateLimiterService,
        RateLimiterGuard,
        RateLimitInterceptor,
      ],
      exports: [RateLimiterService, RateLimiterGuard, RateLimitInterceptor],
    };
  }
}
