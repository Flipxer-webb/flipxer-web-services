/**
 * Rate Limiter Guard
 * 
 * NestJS guard that enforces rate limits on routes.
 * Can be applied globally, to controllers, or to individual routes.
 * 
 * Usage:
 * ```typescript
 * @UseGuards(RateLimiterGuard)
 * @RateLimit({ limit: 10, windowSeconds: 60 })
 * @Get('endpoint')
 * async endpoint() {}
 * ```
 */

import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { RateLimiterService } from '../services/rate-limiter.service';

export const RATE_LIMIT_KEY = 'rateLimit';

export interface RateLimitOptions {
  /**
   * Maximum requests allowed in the window
   */
  limit?: number;
  
  /**
   * Time window in seconds
   */
  windowSeconds?: number;
  
  /**
   * Custom key generator function
   */
  keyGenerator?: (req: Request) => string;
  
  /**
   * Whether to skip rate limiting for certain conditions
   */
  skip?: (req: Request) => boolean;
  
  /**
   * Custom error message
   */
  errorMessage?: string;

  /**
   * Whether to allow requests when rate limiting fails (e.g. Redis down).
   * Defaults to true. Set to false for sensitive endpoints (auth, 2FA, password reset).
   */
  failOpen?: boolean;
}

/**
 * Decorator to set rate limit options on a route
 */
export const RateLimit = (options: RateLimitOptions) =>
  SetMetadata(RATE_LIMIT_KEY, options);

/**
 * Decorator for stricter rate limits (e.g., authentication endpoints)
 */
export const StrictRateLimit = () =>
  RateLimit({ limit: 5, windowSeconds: 60, errorMessage: 'Too many attempts. Please try again later.', failOpen: false });

/**
 * Decorator for relaxed rate limits (e.g., read-only endpoints)
 */
export const RelaxedRateLimit = () =>
  RateLimit({ limit: 200, windowSeconds: 60 });

@Injectable()
export class RateLimiterGuard implements CanActivate {
  constructor(
    private readonly rateLimiter: RateLimiterService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    // Get rate limit options from decorator or use defaults
    const options = this.reflector.getAllAndOverride<RateLimitOptions>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    ) ?? {};

    // Check if we should skip rate limiting
    if (options.skip?.(request)) {
      return true;
    }

    // Generate rate limit key
    const key = options.keyGenerator
      ? options.keyGenerator(request)
      : this.getDefaultKey(request);

    // Check rate limit
    const result = await this.rateLimiter.checkLimit(key, {
      limit: options.limit,
      windowSeconds: options.windowSeconds,
      failOpen: options.failOpen,
    });

    // Set rate limit headers
    response.setHeader('X-RateLimit-Limit', options.limit ?? 100);
    response.setHeader('X-RateLimit-Remaining', result.remaining);
    response.setHeader('X-RateLimit-Reset', Math.ceil(result.resetTime / 1000));

    if (!result.allowed) {
      response.setHeader('Retry-After', result.retryAfter ?? 60);
      
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: options.errorMessage ?? 'Too many requests. Please try again later.',
          retryAfter: result.retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  /**
   * Default key generator using IP address and user ID
   */
  private getDefaultKey(request: Request): string {
    const ip = this.getClientIp(request);
    const userId = (request as any).user?.id;
    const path = request.path;
    
    if (userId) {
      return `user:${userId}:${path}`;
    }
    return `ip:${ip}:${path}`;
  }

  /**
   * Extract client IP from request
   */
  private getClientIp(request: Request): string {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0].trim();
    }
    if (Array.isArray(forwarded)) {
      return forwarded[0];
    }
    return request.ip ?? 'unknown';
  }
}
