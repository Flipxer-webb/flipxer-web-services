import { Injectable, Logger, HttpStatus, BadRequestException, NotFoundException } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "@/modules/core/prisma/services";
import { QuidaxCacheService } from "@/modules/core/redisCache/services/quidax-cache.service";
import { PushNotificationService } from "@/modules/api/notification/services/push.notification.service";
import { buildResponse } from "@/utils/api-response-util";
import { PriceDirection, User } from "@prisma/client";

export interface CreatePriceAlertDto {
    currency: string;
    targetPrice: number;
    direction: "ABOVE" | "BELOW";
    expiresAt?: Date;
}

export interface UpdatePriceAlertDto {
    targetPrice?: number;
    direction?: "ABOVE" | "BELOW";
    isActive?: boolean;
    expiresAt?: Date;
}

@Injectable()
export class PriceAlertService {
    private readonly logger = new Logger(PriceAlertService.name);
    private readonly MAX_ALERTS_PER_USER = 10; // Limit alerts per user

    constructor(
        private prisma: PrismaService,
        private quidaxCacheService: QuidaxCacheService,
        private pushNotificationService: PushNotificationService
    ) {}

    /**
     * Create a new price alert
     */
    async createAlert(user: User, dto: CreatePriceAlertDto): Promise<ApiResponse> {
        // Check user's alert count
        const alertCount = await this.prisma.priceAlert.count({
            where: { userId: user.id, isActive: true },
        });

        if (alertCount >= this.MAX_ALERTS_PER_USER) {
            throw new BadRequestException(
                `Maximum ${this.MAX_ALERTS_PER_USER} active alerts allowed`
            );
        }

        // Set default expiration to 30 days if not provided
        const expiresAt = dto.expiresAt || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

        const alert = await this.prisma.priceAlert.create({
            data: {
                userId: user.id,
                currency: dto.currency.toUpperCase(),
                targetPrice: dto.targetPrice,
                direction: dto.direction as PriceDirection,
                expiresAt,
            },
        });

        return buildResponse({
            message: "Price alert created",
            data: alert,
        });
    }

    /**
     * Get all alerts for a user
     */
    async getUserAlerts(user: User): Promise<ApiResponse> {
        const alerts = await this.prisma.priceAlert.findMany({
            where: { userId: user.id },
            orderBy: { createdAt: "desc" },
        });

        return buildResponse({
            message: "Price alerts retrieved",
            data: alerts,
        });
    }

    /**
     * Get a single alert
     */
    async getAlert(user: User, alertId: number): Promise<ApiResponse> {
        const alert = await this.prisma.priceAlert.findFirst({
            where: { id: alertId, userId: user.id },
        });

        if (!alert) {
            throw new NotFoundException("Alert not found");
        }

        return buildResponse({
            message: "Price alert retrieved",
            data: alert,
        });
    }

    /**
     * Update an alert
     */
    async updateAlert(
        user: User,
        alertId: number,
        dto: UpdatePriceAlertDto
    ): Promise<ApiResponse> {
        const alert = await this.prisma.priceAlert.findFirst({
            where: { id: alertId, userId: user.id },
        });

        if (!alert) {
            throw new NotFoundException("Alert not found");
        }

        const updated = await this.prisma.priceAlert.update({
            where: { id: alertId },
            data: {
                ...(dto.targetPrice !== undefined && { targetPrice: dto.targetPrice }),
                ...(dto.direction && { direction: dto.direction as PriceDirection }),
                ...(dto.isActive !== undefined && { isActive: dto.isActive }),
                ...(dto.expiresAt && { expiresAt: dto.expiresAt }),
                // Reset triggered state if reactivating
                ...(dto.isActive === true && { triggeredAt: null }),
            },
        });

        return buildResponse({
            message: "Price alert updated",
            data: updated,
        });
    }

    /**
     * Delete an alert
     */
    async deleteAlert(user: User, alertId: number): Promise<ApiResponse> {
        const alert = await this.prisma.priceAlert.findFirst({
            where: { id: alertId, userId: user.id },
        });

        if (!alert) {
            throw new NotFoundException("Alert not found");
        }

        await this.prisma.priceAlert.delete({
            where: { id: alertId },
        });

        return buildResponse({
            message: "Price alert deleted",
            data: null,
        });
    }

    /**
     * Check all active price alerts against current prices
     * Runs every minute
     */
    @Cron(CronExpression.EVERY_MINUTE)
    async checkPriceAlerts(): Promise<void> {
        try {
            // Get current market prices
            const marketData = await this.quidaxCacheService.getMarketTickers();
            
            if (!marketData || Object.keys(marketData).length === 0) {
                this.logger.warn("No market data available for price alert check");
                return;
            }

            // Get all active, non-expired alerts
            const activeAlerts = await this.prisma.priceAlert.findMany({
                where: {
                    isActive: true,
                    triggeredAt: null,
                    OR: [
                        { expiresAt: null },
                        { expiresAt: { gt: new Date() } },
                    ],
                },
                include: {
                    user: {
                        select: {
                            id: true,
                            notificationToken: true,
                            email: true,
                            firstName: true,
                        },
                    },
                },
            });

            if (activeAlerts.length === 0) {
                return;
            }

            this.logger.log(`Checking ${activeAlerts.length} active price alerts`);

            for (const alert of activeAlerts) {
                await this.processAlert(alert, marketData);
            }
        } catch (error) {
            this.logger.error("Error checking price alerts:", error);
        }
    }

    /**
     * Process a single alert against market data
     */
    private async processAlert(
        alert: any,
        marketData: Record<string, any>
    ): Promise<void> {
        try {
            // Market data keys are like "btcngn", "ethngn"
            const marketKey = `${alert.currency.toLowerCase()}ngn`;
            const ticker = marketData[marketKey];

            if (!ticker) {
                return; // Currency not found in market data
            }

            const currentPrice = parseFloat(ticker.last || ticker.price || "0");
            
            if (currentPrice === 0) {
                return;
            }

            let shouldTrigger = false;

            if (alert.direction === PriceDirection.ABOVE && currentPrice >= alert.targetPrice) {
                shouldTrigger = true;
            } else if (alert.direction === PriceDirection.BELOW && currentPrice <= alert.targetPrice) {
                shouldTrigger = true;
            }

            if (shouldTrigger) {
                await this.triggerAlert(alert, currentPrice);
            }
        } catch (error) {
            this.logger.error(`Error processing alert ${alert.id}:`, error);
        }
    }

    /**
     * Trigger an alert and send notification
     */
    private async triggerAlert(alert: any, currentPrice: number): Promise<void> {
        // Mark alert as triggered
        await this.prisma.priceAlert.update({
            where: { id: alert.id },
            data: {
                triggeredAt: new Date(),
                isActive: false, // Deactivate after trigger
            },
        });

        const direction = alert.direction === PriceDirection.ABOVE ? "above" : "below";
        const formattedPrice = new Intl.NumberFormat("en-NG", {
            style: "currency",
            currency: "NGN",
        }).format(currentPrice);

        const title = `${alert.currency} Price Alert`;
        const body = `${alert.currency} is now ${direction} your target! Current price: ${formattedPrice}`;

        // Check notification preferences before sending
        const notifPrefs = await this.prisma.notificationPreferences.findUnique({
            where: { userId: alert.userId },
        });

        // Respect quiet hours
        if (notifPrefs?.quietHoursEnabled && this.isQuietHours(notifPrefs)) {
            this.logger.log(`Skipping push for alert ${alert.id} during quiet hours`);
            // Still create in-app notification
        }

        // Create in-app notification
        await this.prisma.notification.create({
            data: {
                title,
                body,
                userId: alert.userId,
                target: "SINGLE",
                beneficiary: "INDIVIDUAL",
                type: "PUSH_NOTIFICATION",
                status: "APPROVED",
                senderId: null,
                transactionType: null,
                currency: alert.currency,
            },
        });

        // Send push notification if user has token and hasn't disabled price alerts
        if (
            alert.user.notificationToken &&
            (notifPrefs?.pushPriceAlerts !== false) &&
            !(notifPrefs?.quietHoursEnabled && this.isQuietHours(notifPrefs))
        ) {
            await this.pushNotificationService.sendToDevice(
                alert.user.notificationToken,
                {
                    title,
                    body,
                    data: {
                        type: "PRICE_ALERT",
                        currency: alert.currency,
                        alertId: alert.id.toString(),
                    },
                }
            );
        }

        this.logger.log(`Triggered price alert ${alert.id} for user ${alert.userId}`);
    }

    /**
     * Check if current time is within quiet hours
     */
    private isQuietHours(prefs: { quietHoursStart?: string; quietHoursEnd?: string }): boolean {
        if (!prefs.quietHoursStart || !prefs.quietHoursEnd) {
            return false;
        }

        const now = new Date();
        const currentMinutes = now.getHours() * 60 + now.getMinutes();

        const [startHour, startMin] = prefs.quietHoursStart.split(":").map(Number);
        const [endHour, endMin] = prefs.quietHoursEnd.split(":").map(Number);
        
        const startMinutes = startHour * 60 + startMin;
        const endMinutes = endHour * 60 + endMin;

        // Handle overnight quiet hours (e.g., 22:00 to 07:00)
        if (startMinutes > endMinutes) {
            return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
        }

        return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
    }

    /**
     * Clean up expired alerts (runs daily)
     */
    @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
    async cleanupExpiredAlerts(): Promise<void> {
        try {
            const result = await this.prisma.priceAlert.deleteMany({
                where: {
                    expiresAt: { lt: new Date() },
                },
            });

            if (result.count > 0) {
                this.logger.log(`Cleaned up ${result.count} expired price alerts`);
            }
        } catch (error) {
            this.logger.error("Error cleaning up expired alerts:", error);
        }
    }
}
