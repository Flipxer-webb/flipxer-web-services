/**
 * Rate Limit Interceptor
 * 
 * Alternative to the guard - can be used to add rate limit headers
 * without blocking requests (soft rate limiting).
 */

import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { Response } from 'express';
import { RateLimiterService } from '../services/rate-limiter.service';

@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  constructor(private readonly rateLimiter: RateLimiterService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse<Response>();

    const key = this.getKey(request);
    const result = await this.rateLimiter.checkLimit(key);

    // Always set headers, but don't block
    response.setHeader('X-RateLimit-Limit', 100);
    response.setHeader('X-RateLimit-Remaining', result.remaining);
    response.setHeader('X-RateLimit-Reset', Math.ceil(result.resetTime / 1000));

    return next.handle();
  }

  private getKey(request: any): string {
    const ip = request.headers['x-forwarded-for']?.split(',')[0] || request.ip;
    const userId = request.user?.id;
    return userId ? `user:${userId}` : `ip:${ip}`;
  }
}
