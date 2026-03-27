import { Injectable, Logger, HttpStatus } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { ApiResponse, buildResponse } from "@/utils/api-response-util";
import { User } from "@prisma/client";
import { SessionInfo, SessionResponse } from "../interfaces";
import {
    SessionNotFoundException,
    InvalidSessionException,
} from "../errors";
import { REFRESH_TOKEN_EXPIRATION } from "@/config";
import { getBotTrafficReason, isCloudProviderIP, isSuspiciousCombination } from "../utils/bot-detection";

// Server-side inactivity limit (30 minutes) - sessions inactive beyond this are considered invalid
const SERVER_INACTIVITY_LIMIT_MS = 30 * 60 * 1000;

// Minimum time between session extend calls (rate limiting)
const MIN_TIME_BETWEEN_EXTENDS_MS = 60 * 1000; // 1 minute

@Injectable()
export class SessionService {
    private readonly logger = new Logger(SessionService.name);

    constructor(private readonly prisma: PrismaService) { }

    /**
     * Parse duration string to milliseconds
     */
    private parseDuration(duration: string): number {
        const durationRegex = /^(\d+)([dhms])$/;
        const match = durationRegex.exec(duration);
        if (!match) return 7 * 24 * 60 * 60 * 1000; // Default 7 days

        const value = Number.parseInt(match[1]);
        const unit = match[2];

        switch (unit) {
            case "d":
                return value * 24 * 60 * 60 * 1000;
            case "h":
                return value * 60 * 60 * 1000;
            case "m":
                return value * 60 * 1000;
            case "s":
                return value * 1000;
            default:
                return 7 * 24 * 60 * 60 * 1000;
        }
    }

    /**
     * Create a new session for user login
     * Returns an object with sessionId and deviceToken
     */
    async createSession(
        userId: number,
        sessionInfo: SessionInfo
    ): Promise<{ sessionId: string }> {
        // Check for bot/health check traffic
        const botReason = getBotTrafficReason({
            browser: sessionInfo.browser,
            os: sessionInfo.os,
            ipAddress: sessionInfo.ipAddress,
            deviceName: sessionInfo.deviceName,
        });

        if (botReason) {
            this.logger.warn(
                `Detected potential bot traffic for user ${userId}: ${botReason}`
            );
            // Still create session but log it - we may want to skip entirely in the future
        }

        // Deactivate current session flag from other sessions
        await this.prisma.session.updateMany({
            where: { userId, isCurrent: true },
            data: { isCurrent: false },
        });

        const expiresAt = new Date(
            Date.now() + this.parseDuration(REFRESH_TOKEN_EXPIRATION)
        );

        const session = await this.prisma.session.create({
            data: {
                userId,
                deviceName: sessionInfo.deviceName,
                deviceType: sessionInfo.deviceType,
                browser: sessionInfo.browser,
                os: sessionInfo.os,
                ipAddress: sessionInfo.ipAddress,
                location: sessionInfo.location,
                isActive: true,
                isCurrent: true,
                expiresAt,
            },
        });

        return { sessionId: session.id };
    }

    /**
     * Get all active sessions for a user
     */
    async getUserSessions(
        user: User,
        currentSessionId?: string
    ): Promise<ApiResponse> {
        const sessions = await this.prisma.session.findMany({
            where: {
                userId: user.id,
                isActive: true,
                expiresAt: { gt: new Date() },
            },
            orderBy: { lastActiveAt: "desc" },
            select: {
                id: true,
                deviceName: true,
                deviceType: true,
                browser: true,
                os: true,
                ipAddress: true,
                location: true,
                isActive: true,
                isCurrent: true,
                lastActiveAt: true,
                createdAt: true,
            },
        });

        // Mark current session if sessionId is provided
        const formattedSessions: SessionResponse[] = sessions.map((session) => ({
            ...session,
            isCurrent: currentSessionId
                ? session.id === currentSessionId
                : session.isCurrent,
        }));

        return buildResponse({
            message: "Sessions retrieved successfully",
            data: {
                sessions: formattedSessions,
                totalCount: formattedSessions.length,
            },
        });
    }

    /**
     * Revoke a specific session
     */
    async revokeSession(
        user: User,
        sessionId: string,
        currentSessionId?: string
    ): Promise<ApiResponse> {
        const session = await this.prisma.session.findFirst({
            where: { id: sessionId, userId: user.id },
        });

        if (!session) {
            throw new SessionNotFoundException(
                "Session not found",
                HttpStatus.NOT_FOUND
            );
        }

        // Prevent revoking current session through this method
        if (currentSessionId && sessionId === currentSessionId) {
            throw new InvalidSessionException(
                "Cannot revoke current session. Use logout instead.",
                HttpStatus.BAD_REQUEST
            );
        }

        await this.prisma.session.update({
            where: { id: sessionId },
            data: { isActive: false },
        });

        this.logger.log(`Session ${sessionId} revoked for user ${user.id}`);

        return buildResponse({
            message: "Session revoked successfully",
        });
    }

    /**
     * Revoke all sessions except the current one
     */
    async revokeAllOtherSessions(
        user: User,
        currentSessionId: string
    ): Promise<ApiResponse> {
        const result = await this.prisma.session.updateMany({
            where: {
                userId: user.id,
                id: { not: currentSessionId },
                isActive: true,
            },
            data: { isActive: false },
        });

        this.logger.log(
            `${result.count} sessions revoked for user ${user.id}`
        );

        return buildResponse({
            message: `${result.count} session(s) revoked successfully`,
            data: { revokedCount: result.count },
        });
    }

    /**
     * Update session activity timestamp
     */
    async updateSessionActivity(sessionId: string): Promise<void> {
        try {
            await this.prisma.session.update({
                where: { id: sessionId },
                data: { lastActiveAt: new Date() },
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger.warn(`Failed to update session activity: ${sessionId} - ${errorMessage}`);
        }
    }

    /**
     * Touch session activity at most once per minute to reduce write load.
     */
    async touchSessionActivity(sessionId: string): Promise<void> {
        try {
            const staleThreshold = new Date(
                Date.now() - MIN_TIME_BETWEEN_EXTENDS_MS
            );

            await this.prisma.session.updateMany({
                where: {
                    id: sessionId,
                    isActive: true,
                    lastActiveAt: { lt: staleThreshold },
                },
                data: { lastActiveAt: new Date() },
            });
        } catch (error) {
            this.logger.warn(`Failed to touch session activity: ${sessionId} - ${error}`);
        }
    }

    /**
     * Validate if a session is active, not expired, and not inactive too long
     */
    async validateSession(sessionId: string): Promise<boolean> {
        const inactivityThreshold = new Date(Date.now() - SERVER_INACTIVITY_LIMIT_MS);

        const session = await this.prisma.session.findFirst({
            where: {
                id: sessionId,
                isActive: true,
                expiresAt: { gt: new Date() },
                // Server-side inactivity check: session must have been active within the limit
                lastActiveAt: { gt: inactivityThreshold },
            },
        });

        return !!session;
    }

    /**
     * Extend session expiration
     */
    async extendSession(
        user: User,
        sessionId: string
    ): Promise<ApiResponse> {
        const session = await this.prisma.session.findFirst({
            where: {
                id: sessionId,
                userId: user.id,
                isActive: true,
            },
        });

        if (!session) {
            throw new SessionNotFoundException(
                "Session not found or inactive",
                HttpStatus.NOT_FOUND
            );
        }

        // Rate limit: only allow extend once per minute
        const timeSinceLastActivity = Date.now() - session.lastActiveAt.getTime();
        if (timeSinceLastActivity < MIN_TIME_BETWEEN_EXTENDS_MS) {
            return buildResponse({
                message: "Session already recently extended",
                data: { expiresAt: session.expiresAt },
            });
        }

        const newExpiresAt = new Date(
            Date.now() + this.parseDuration(REFRESH_TOKEN_EXPIRATION)
        );

        await this.prisma.session.update({
            where: { id: sessionId },
            data: {
                expiresAt: newExpiresAt,
                lastActiveAt: new Date(),
            },
        });

        return buildResponse({
            message: "Session extended successfully",
            data: { expiresAt: newExpiresAt },
        });
    }

    /**
     * Invalidate session on logout
     */
    async invalidateSession(sessionId: string): Promise<void> {
        try {
            await this.prisma.session.update({
                where: { id: sessionId },
                data: { isActive: false },
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger.warn(`Failed to invalidate session: ${sessionId} - ${errorMessage}`);
        }
    }

    /**
     * Invalidate the current session for authenticated user logout
     */
    async invalidateCurrentSession(user: User, sessionId: string): Promise<ApiResponse> {
        const session = await this.prisma.session.findFirst({
            where: { id: sessionId, userId: user.id },
        });

        if (!session) {
            return buildResponse({
                message: "Session already invalid or not found",
            });
        }

        await this.prisma.session.update({
            where: { id: sessionId },
            data: { isActive: false },
        });

        return buildResponse({
            message: "Session invalidated successfully",
        });
    }

    /**
     * Cleanup expired sessions (can be run via cron)
     */
    async cleanupExpiredSessions(): Promise<number> {
        const result = await this.prisma.session.deleteMany({
            where: {
                OR: [
                    { expiresAt: { lt: new Date() } },
                    {
                        isActive: false,
                        updatedAt: {
                            lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
                        },
                    },
                ],
            },
        });

        this.logger.log(`Cleaned up ${result.count} expired sessions`);
        return result.count;
    }

    /**
     * Get session count for user
     */
    async getActiveSessionCount(userId: number): Promise<number> {
        return this.prisma.session.count({
            where: {
                userId,
                isActive: true,
                expiresAt: { gt: new Date() },
            },
        });
    }

    /**
     * Cleanup sessions that appear to be from bots or health checks
     * This identifies sessions based on:
     * - Cloud provider IP addresses (AWS, etc.)
     * - Suspicious browser/OS combinations (Safari on Linux)
     */
    async cleanupBotSessions(): Promise<number> {
        // Get all active sessions
        const sessions = await this.prisma.session.findMany({
            where: { isActive: true },
            select: {
                id: true,
                browser: true,
                os: true,
                ipAddress: true,
                deviceName: true,
            },
        });

        // Filter sessions that look like bot traffic
        const botSessionIds: string[] = [];
        for (const session of sessions) {
            if (isCloudProviderIP(session.ipAddress)) {
                if (isSuspiciousCombination(session.browser, session.os)) {
                    botSessionIds.push(session.id);
                }
            }
        }

        if (botSessionIds.length === 0) {
            this.logger.log("No bot sessions found to cleanup");
            return 0;
        }

        // Deactivate bot sessions
        const result = await this.prisma.session.updateMany({
            where: { id: { in: botSessionIds } },
            data: { isActive: false },
        });

        this.logger.log(
            `Cleaned up ${result.count} bot/health-check sessions`
        );
        return result.count;
    }
}
