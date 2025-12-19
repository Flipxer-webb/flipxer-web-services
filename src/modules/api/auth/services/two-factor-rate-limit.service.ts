/**
 * Two-Factor Authentication Rate Limiting Service
 * 
 * Implements exponential backoff for failed 2FA attempts:
 * - 1st failure: instant (no delay)
 * - 2nd failure: 30 seconds lockout
 * - 3rd failure: 5 minutes lockout
 * - 4th+ failure: 1 hour lockout
 * 
 * Provides admin reset option for locked accounts.
 */

import { Injectable, Logger } from '@nestjs/common';
import { RedisCacheService } from '@/modules/core/redisCache/services/redis-cache.service';

export interface TwoFactorAttemptResult {
  allowed: boolean;
  remainingAttempts: number;
  lockoutEndsAt?: number; // Unix timestamp in milliseconds
  lockoutDuration?: number; // Seconds
}

interface AttemptRecord {
  count: number;
  lastAttemptAt: number;
  lockoutEndsAt?: number;
}

@Injectable()
export class TwoFactorRateLimitService {
  private readonly logger = new Logger(TwoFactorRateLimitService.name);
  
  // Key prefixes for Redis
  private readonly ATTEMPT_KEY_PREFIX = '2fa:attempts:';
  private readonly LOCKOUT_KEY_PREFIX = '2fa:lockout:';
  
  // Exponential backoff configuration (in seconds)
  private readonly BACKOFF_DELAYS = [
    0,      // 1st attempt: instant
    30,     // 2nd attempt: 30 seconds
    300,    // 3rd attempt: 5 minutes
    3600,   // 4th+ attempt: 1 hour
  ];
  
  // Maximum attempts before lockout
  private readonly MAX_ATTEMPTS = 5;
  
  // TTL for attempt tracking (24 hours)
  private readonly ATTEMPT_TTL = 24 * 60 * 60;

  constructor(private readonly redisCacheService: RedisCacheService) {}

  /**
   * Check if a 2FA attempt is allowed for a user
   * 
   * @param userId - User ID attempting 2FA verification
   * @param context - Context of the attempt (e.g., 'login', 'transaction')
   * @returns Result indicating if attempt is allowed and lockout info
   */
  async checkAttempt(
    userId: string,
    context: 'login' | 'transaction' = 'login',
  ): Promise<TwoFactorAttemptResult> {
    const attemptKey = `${this.ATTEMPT_KEY_PREFIX}${context}:${userId}`;
    const lockoutKey = `${this.LOCKOUT_KEY_PREFIX}${context}:${userId}`;
    
    // Check if user is currently locked out
    const lockoutEndsAt = await this.redisCacheService.get<number>(lockoutKey);
    const now = Date.now();
    
    if (lockoutEndsAt && lockoutEndsAt > now) {
      const lockoutDuration = Math.ceil((lockoutEndsAt - now) / 1000);
      return {
        allowed: false,
        remainingAttempts: 0,
        lockoutEndsAt,
        lockoutDuration,
      };
    }
    
    // Get attempt record
    const record = await this.redisCacheService.get<AttemptRecord>(attemptKey);
    
    if (!record) {
      // First attempt
      return {
        allowed: true,
        remainingAttempts: this.MAX_ATTEMPTS - 1,
      };
    }
    
    // Check if attempts should be reset (after 24 hours of no activity)
    if (now - record.lastAttemptAt > this.ATTEMPT_TTL * 1000) {
      await this.resetAttempts(userId, context);
      return {
        allowed: true,
        remainingAttempts: this.MAX_ATTEMPTS - 1,
      };
    }
    
    const remainingAttempts = Math.max(0, this.MAX_ATTEMPTS - record.count);
    
    return {
      allowed: true,
      remainingAttempts,
    };
  }

  /**
   * Record a failed 2FA attempt and apply exponential backoff if needed
   * 
   * @param userId - User ID with failed attempt
   * @param context - Context of the attempt
   * @returns Updated attempt result with lockout info
   */
  async recordFailedAttempt(
    userId: string,
    context: 'login' | 'transaction' = 'login',
  ): Promise<TwoFactorAttemptResult> {
    const attemptKey = `${this.ATTEMPT_KEY_PREFIX}${context}:${userId}`;
    const lockoutKey = `${this.LOCKOUT_KEY_PREFIX}${context}:${userId}`;
    const now = Date.now();
    
    // Get or create attempt record
    const record = await this.redisCacheService.get<AttemptRecord>(attemptKey) || {
      count: 0,
      lastAttemptAt: now,
    };
    
    // Increment count
    record.count++;
    record.lastAttemptAt = now;
    
    // Calculate backoff delay based on attempt count
    const delayIndex = Math.min(record.count - 1, this.BACKOFF_DELAYS.length - 1);
    const delaySeconds = this.BACKOFF_DELAYS[delayIndex];
    
    let lockoutEndsAt: number | undefined;
    let lockoutDuration: number | undefined;
    
    if (delaySeconds > 0) {
      lockoutEndsAt = now + delaySeconds * 1000;
      lockoutDuration = delaySeconds;
      record.lockoutEndsAt = lockoutEndsAt;
      
      // Store lockout expiry
      await this.redisCacheService.set(lockoutKey, lockoutEndsAt, delaySeconds);
      
      this.logger.warn(
        `2FA ${context} lockout applied for user ${userId}: ${delaySeconds}s (attempt ${record.count})`,
      );
    }
    
    // Store updated attempt record
    await this.redisCacheService.set(attemptKey, record, this.ATTEMPT_TTL);
    
    const remainingAttempts = Math.max(0, this.MAX_ATTEMPTS - record.count);
    
    return {
      allowed: delaySeconds === 0,
      remainingAttempts,
      lockoutEndsAt,
      lockoutDuration,
    };
  }

  /**
   * Record a successful 2FA attempt and clear failure tracking
   * 
   * @param userId - User ID with successful attempt
   * @param context - Context of the attempt
   */
  async recordSuccessfulAttempt(
    userId: string,
    context: 'login' | 'transaction' = 'login',
  ): Promise<void> {
    await this.resetAttempts(userId, context);
    this.logger.log(`2FA ${context} successful for user ${userId}, attempts reset`);
  }

  /**
   * Reset all attempt tracking for a user (admin function)
   * 
   * @param userId - User ID to reset
   * @param context - Optional context to reset (if omitted, resets all)
   */
  async resetAttempts(
    userId: string,
    context?: 'login' | 'transaction',
  ): Promise<void> {
    if (context) {
      // Reset specific context
      const attemptKey = `${this.ATTEMPT_KEY_PREFIX}${context}:${userId}`;
      const lockoutKey = `${this.LOCKOUT_KEY_PREFIX}${context}:${userId}`;
      
      await Promise.all([
        this.redisCacheService.del(attemptKey),
        this.redisCacheService.del(lockoutKey),
      ]);
      
      this.logger.log(`Reset 2FA ${context} attempts for user ${userId}`);
    } else {
      // Reset all contexts
      await Promise.all([
        this.resetAttempts(userId, 'login'),
        this.resetAttempts(userId, 'transaction'),
      ]);
      
      this.logger.log(`Reset all 2FA attempts for user ${userId}`);
    }
  }

  /**
   * Get current attempt status without modifying it (for admin dashboard)
   * 
   * @param userId - User ID to check
   * @param context - Context to check
   * @returns Current attempt result or null if no attempts recorded
   */
  async getAttemptStatus(
    userId: string,
    context: 'login' | 'transaction' = 'login',
  ): Promise<TwoFactorAttemptResult | null> {
    const attemptKey = `${this.ATTEMPT_KEY_PREFIX}${context}:${userId}`;
    const lockoutKey = `${this.LOCKOUT_KEY_PREFIX}${context}:${userId}`;
    
    const [record, lockoutEndsAt] = await Promise.all([
      this.redisCacheService.get<AttemptRecord>(attemptKey),
      this.redisCacheService.get<number>(lockoutKey),
    ]);
    
    if (!record && !lockoutEndsAt) {
      return null;
    }
    
    const now = Date.now();
    const remainingAttempts = record 
      ? Math.max(0, this.MAX_ATTEMPTS - record.count)
      : this.MAX_ATTEMPTS;
    
    if (lockoutEndsAt && lockoutEndsAt > now) {
      return {
        allowed: false,
        remainingAttempts: 0,
        lockoutEndsAt,
        lockoutDuration: Math.ceil((lockoutEndsAt - now) / 1000),
      };
    }
    
    return {
      allowed: true,
      remainingAttempts,
    };
  }
}
