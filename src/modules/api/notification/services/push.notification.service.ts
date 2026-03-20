import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import * as admin from "firebase-admin";
import { PrismaService } from "@/modules/core/prisma/services";

export interface PushNotificationPayload {
    title: string;
    body: string;
    data?: Record<string, string>;
    imageUrl?: string;
}

export interface PushResult {
    successCount: number;
    failureCount: number;
    failedTokens: string[];
}

@Injectable()
export class PushNotificationService implements OnModuleInit {
    private readonly logger = new Logger(PushNotificationService.name);
    private isInitialized = false;

    constructor(private prisma: PrismaService) {}

    onModuleInit() {
        this.initializeFirebase();
    }

    private initializeFirebase() {
        try {
            const projectId = process.env.FIREBASE_PROJECT_ID;
            const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
            const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

            if (!projectId || !clientEmail || !privateKey) {
                this.logger.warn(
                    "Firebase credentials not configured. Push notifications will be disabled. " +
                    "Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY to enable."
                );
                return;
            }

            // Check if Firebase is already initialized
            if (admin.apps.length === 0) {
                admin.initializeApp({
                    credential: admin.credential.cert({
                        projectId,
                        clientEmail,
                        privateKey,
                    }),
                });
                this.isInitialized = true;
                this.logger.log("Firebase Admin SDK initialized successfully");
            } else {
                this.isInitialized = true;
                this.logger.log("Firebase Admin SDK already initialized");
            }
        } catch (error) {
            this.logger.error("Failed to initialize Firebase Admin SDK:", error);
            this.isInitialized = false;
        }
    }

    /**
     * Check if push notifications are available
     */
    isAvailable(): boolean {
        return this.isInitialized;
    }

    /**
     * Send push notification to a single device
     */
    async sendToDevice(
        token: string,
        payload: PushNotificationPayload
    ): Promise<boolean> {
        if (!this.isInitialized) {
            this.logger.warn("Push notification skipped: Firebase not initialized");
            return false;
        }

        if (!token) {
            this.logger.warn("Push notification skipped: No device token provided");
            return false;
        }

        try {
            const message: admin.messaging.Message = {
                token,
                notification: {
                    title: payload.title,
                    body: payload.body,
                    ...(payload.imageUrl && { imageUrl: payload.imageUrl }),
                },
                data: payload.data,
                android: {
                    priority: "high",
                    notification: {
                        sound: "default",
                        channelId: "flipxer_default",
                    },
                },
                apns: {
                    payload: {
                        aps: {
                            sound: "default",
                            badge: 1,
                        },
                    },
                },
            };

            const response = await admin.messaging().send(message);
            this.logger.log(`Push notification sent successfully: ${response}`);
            return true;
        } catch (error: any) {
            this.logger.error(`Failed to send push notification: ${error.message}`);
            
            // Handle invalid tokens
            if (
                error.code === "messaging/invalid-registration-token" ||
                error.code === "messaging/registration-token-not-registered"
            ) {
                await this.invalidateToken(token);
            }
            
            return false;
        }
    }

    /**
     * Send push notification to multiple devices
     */
    async sendToMultipleDevices(
        tokens: string[],
        payload: PushNotificationPayload
    ): Promise<PushResult> {
        if (!this.isInitialized) {
            this.logger.warn("Push notifications skipped: Firebase not initialized");
            return { successCount: 0, failureCount: 0, failedTokens: [] };
        }

        // Filter out empty tokens
        const validTokens = tokens.filter((token) => token && token.trim());
        
        if (validTokens.length === 0) {
            this.logger.warn("Push notifications skipped: No valid device tokens");
            return { successCount: 0, failureCount: 0, failedTokens: [] };
        }

        try {
            const message: admin.messaging.MulticastMessage = {
                tokens: validTokens,
                notification: {
                    title: payload.title,
                    body: payload.body,
                    ...(payload.imageUrl && { imageUrl: payload.imageUrl }),
                },
                data: payload.data,
                android: {
                    priority: "high",
                    notification: {
                        sound: "default",
                        channelId: "flipxer_default",
                    },
                },
                apns: {
                    payload: {
                        aps: {
                            sound: "default",
                            badge: 1,
                        },
                    },
                },
            };

            const response = await admin.messaging().sendEachForMulticast(message);
            
            this.logger.log(
                `Push notifications sent: ${response.successCount} success, ${response.failureCount} failed`
            );

            // Collect failed tokens for cleanup
            const failedTokens: string[] = [];
            response.responses.forEach((resp, idx) => {
                if (!resp.success && resp.error) {
                    const errorCode = resp.error.code;
                    if (
                        errorCode === "messaging/invalid-registration-token" ||
                        errorCode === "messaging/registration-token-not-registered"
                    ) {
                        failedTokens.push(validTokens[idx]);
                    }
                }
            });

            // Invalidate failed tokens
            if (failedTokens.length > 0) {
                await this.invalidateTokens(failedTokens);
            }

            return {
                successCount: response.successCount,
                failureCount: response.failureCount,
                failedTokens,
            };
        } catch (error: any) {
            this.logger.error(`Failed to send multicast push notification: ${error.message}`);
            return { 
                successCount: 0, 
                failureCount: validTokens.length, 
                failedTokens: validTokens 
            };
        }
    }

    /**
     * Send push notification to a user by their ID (all devices)
     */
    async sendToUser(
        userId: number,
        payload: PushNotificationPayload
    ): Promise<boolean> {
        try {
            const deviceTokens = await this.prisma.deviceToken.findMany({
                where: { userId },
                select: { token: true },
            });

            if (deviceTokens.length === 0) {
                // Fallback: check legacy User.notificationToken
                const user = await this.prisma.user.findUnique({
                    where: { id: userId },
                    select: { notificationToken: true },
                });
                if (!user?.notificationToken) {
                    this.logger.warn(`User ${userId} has no device tokens`);
                    return false;
                }
                return await this.sendToDevice(user.notificationToken, payload);
            }

            const tokens = deviceTokens.map((d) => d.token);
            if (tokens.length === 1) {
                return await this.sendToDevice(tokens[0], payload);
            }

            const result = await this.sendToMultipleDevices(tokens, payload);
            return result.successCount > 0;
        } catch (error: any) {
            this.logger.error(`Failed to send push to user ${userId}: ${error.message}`);
            return false;
        }
    }

    /**
     * Send push notification to multiple users by their IDs
     */
    async sendToUsers(
        userIds: number[],
        payload: PushNotificationPayload
    ): Promise<PushResult> {
        try {
            const deviceTokens = await this.prisma.deviceToken.findMany({
                where: { userId: { in: userIds } },
                select: { token: true },
            });

            const tokens = deviceTokens.map((d) => d.token);

            // Fallback: also check legacy User.notificationToken
            const legacyUsers = await this.prisma.user.findMany({
                where: {
                    id: { in: userIds },
                    notificationToken: { not: null },
                },
                select: { notificationToken: true },
            });
            const legacyTokens = legacyUsers
                .map((u) => u.notificationToken)
                .filter((t): t is string => t !== null);

            const allTokens = [...new Set([...tokens, ...legacyTokens])];

            if (allTokens.length === 0) {
                this.logger.warn("No users with device tokens found");
                return { successCount: 0, failureCount: 0, failedTokens: [] };
            }

            return await this.sendToMultipleDevices(allTokens, payload);
        } catch (error: any) {
            this.logger.error(`Failed to send push to users: ${error.message}`);
            return { successCount: 0, failureCount: userIds.length, failedTokens: [] };
        }
    }

    /**
     * Invalidate a single token (remove from DeviceToken table + legacy User field)
     */
    private async invalidateToken(token: string): Promise<void> {
        try {
            await this.prisma.deviceToken.deleteMany({
                where: { token },
            });
            // Also clear legacy field
            await this.prisma.user.updateMany({
                where: { notificationToken: token },
                data: { notificationToken: null },
            });
            this.logger.log(`Invalidated push token: ${token.substring(0, 20)}...`);
        } catch (error: any) {
            this.logger.error(`Failed to invalidate token: ${error.message}`);
        }
    }

    /**
     * Invalidate multiple tokens
     */
    private async invalidateTokens(tokens: string[]): Promise<void> {
        try {
            await this.prisma.deviceToken.deleteMany({
                where: { token: { in: tokens } },
            });
            // Also clear legacy field
            await this.prisma.user.updateMany({
                where: { notificationToken: { in: tokens } },
                data: { notificationToken: null },
            });
            this.logger.log(`Invalidated ${tokens.length} push tokens`);
        } catch (error: any) {
            this.logger.error(`Failed to invalidate tokens: ${error.message}`);
        }
    }
}
