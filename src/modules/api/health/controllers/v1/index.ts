import { Controller, Get, HttpStatus, Res } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { Response } from "express";
import { PrismaService } from "@/modules/core/prisma/services";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";

interface HealthCheckResult {
    success: boolean;
    message: string;
    timestamp: string;
    uptime: number;
    uptimeFormatted: string;
    version: string;
    environment: string;
    services: {
        database: {
            healthy: boolean;
            latencyMs?: number;
            error?: string;
        };
        redis: {
            healthy: boolean;
            latencyMs?: number;
            usingFallback: boolean;
            fallbackSize?: number;
            error?: string;
        };
    };
    memory: {
        heapUsedMB: number;
        heapTotalMB: number;
        rssMB: number;
    };
}

@ApiTags("Health")
@Controller({ path: "health", version: "1" })
export class HealthController {
    constructor(
        private readonly prisma: PrismaService,
        private readonly redis: RedisCacheService,
    ) {}

    private formatUptime(seconds: number): string {
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        
        const parts = [];
        if (days > 0) parts.push(`${days}d`);
        if (hours > 0) parts.push(`${hours}h`);
        if (minutes > 0) parts.push(`${minutes}m`);
        parts.push(`${secs}s`);
        
        return parts.join(" ");
    }

    @Get()
    @ApiOperation({ summary: "Comprehensive health check endpoint" })
    @ApiResponse({ status: 200, description: "Server is healthy" })
    @ApiResponse({ status: 503, description: "Server is unhealthy" })
    async check(@Res() res: Response): Promise<Response> {
        const startTime = Date.now();
        
        // Check database health
        let dbHealth: HealthCheckResult["services"]["database"] = { healthy: false };
        try {
            const dbStart = Date.now();
            const isDbHealthy = await this.prisma.isHealthy();
            dbHealth = {
                healthy: isDbHealthy,
                latencyMs: Date.now() - dbStart,
            };
        } catch (error) {
            dbHealth = {
                healthy: false,
                error: error.message,
            };
        }

        // Check Redis health
        let redisHealth: HealthCheckResult["services"]["redis"] = { healthy: false, usingFallback: true };
        try {
            const redisResult = await this.redis.isHealthy();
            const stats = this.redis.getStats();
            redisHealth = {
                ...redisResult,
                fallbackSize: stats.fallbackSize,
            };
        } catch (error) {
            redisHealth = {
                healthy: false,
                usingFallback: true,
                error: error.message,
            };
        }

        // Memory usage
        const memUsage = process.memoryUsage();
        const memory = {
            heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024 * 100) / 100,
            heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024 * 100) / 100,
            rssMB: Math.round(memUsage.rss / 1024 / 1024 * 100) / 100,
        };

        const uptime = process.uptime();
        const overallHealthy = dbHealth.healthy; // DB is critical, Redis has fallback

        const result: HealthCheckResult = {
            success: overallHealthy,
            message: overallHealthy ? "OK" : "DEGRADED",
            timestamp: new Date().toISOString(),
            uptime,
            uptimeFormatted: this.formatUptime(uptime),
            version: process.env.npm_package_version || "1.0.0",
            environment: process.env.NODE_ENV || "development",
            services: {
                database: dbHealth,
                redis: redisHealth,
            },
            memory,
        };

        const statusCode = overallHealthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;
        return res.status(statusCode).json(result);
    }

    @Get("ping")
    @ApiOperation({ summary: "Simple ping endpoint for keep-alive" })
    @ApiResponse({ status: 200, description: "Pong" })
    ping() {
        return { pong: true, timestamp: Date.now() };
    }

    @Get("ready")
    @ApiOperation({ summary: "Readiness check for load balancers" })
    @ApiResponse({ status: 200, description: "Service is ready" })
    @ApiResponse({ status: 503, description: "Service is not ready" })
    async ready(@Res() res: Response): Promise<Response> {
        try {
            const isDbHealthy = await this.prisma.isHealthy();
            if (isDbHealthy) {
                return res.status(HttpStatus.OK).json({ ready: true });
            }
            return res.status(HttpStatus.SERVICE_UNAVAILABLE).json({ ready: false, reason: "database" });
        } catch (error) {
            return res.status(HttpStatus.SERVICE_UNAVAILABLE).json({ ready: false, reason: error.message });
        }
    }

    @Get("live")
    @ApiOperation({ summary: "Liveness check for container orchestration" })
    @ApiResponse({ status: 200, description: "Service is alive" })
    live() {
        return { alive: true, timestamp: Date.now() };
    }
}
