import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { buildResponse } from "@/utils/api-response-util";
import { User, Prisma } from "@prisma/client";

export interface UpdateUserPreferencesDto {
    theme?: "light" | "dark" | "system";
    defaultFiatCurrency?: string;
    favoriteAssets?: string[];
    quickActionOrder?: string[];
    hideZeroBalances?: boolean;
    dashboardLayout?: Record<string, any>;
}

export interface UpdateNotificationPreferencesDto {
    emailTransactions?: boolean;
    emailMarketing?: boolean;
    emailSecurityAlerts?: boolean;
    pushTransactions?: boolean;
    pushPriceAlerts?: boolean;
    pushSecurityAlerts?: boolean;
    pushMarketing?: boolean;
    soundEnabled?: boolean;
    quietHoursEnabled?: boolean;
    quietHoursStart?: string;
    quietHoursEnd?: string;
}

@Injectable()
export class PreferencesService {
    private readonly logger = new Logger(PreferencesService.name);

    constructor(private prisma: PrismaService) {}

    /**
     * Get user preferences - auto-creates if not exists
     */
    async getUserPreferences(user: User): Promise<ApiResponse> {
        let preferences = await this.prisma.userPreferences.findUnique({
            where: { userId: user.id },
        });

        // Auto-create preferences on first access
        if (!preferences) {
            preferences = await this.prisma.userPreferences.create({
                data: { userId: user.id },
            });
        }

        return buildResponse({
            message: "Preferences retrieved",
            data: preferences,
        });
    }

    /**
     * Update user preferences
     */
    async updateUserPreferences(
        user: User,
        dto: UpdateUserPreferencesDto
    ): Promise<ApiResponse> {
        const preferences = await this.prisma.userPreferences.upsert({
            where: { userId: user.id },
            create: {
                userId: user.id,
                ...dto,
            },
            update: dto,
        });

        return buildResponse({
            message: "Preferences updated",
            data: preferences,
        });
    }

    /**
     * Get notification preferences - auto-creates if not exists
     */
    async getNotificationPreferences(user: User): Promise<ApiResponse> {
        let preferences = await this.prisma.notificationPreferences.findUnique({
            where: { userId: user.id },
        });

        // Auto-create preferences on first access
        if (!preferences) {
            preferences = await this.prisma.notificationPreferences.create({
                data: { userId: user.id },
            });
        }

        return buildResponse({
            message: "Notification preferences retrieved",
            data: preferences,
        });
    }

    /**
     * Update notification preferences
     */
    async updateNotificationPreferences(
        user: User,
        dto: UpdateNotificationPreferencesDto
    ): Promise<ApiResponse> {
        const preferences = await this.prisma.notificationPreferences.upsert({
            where: { userId: user.id },
            create: {
                userId: user.id,
                ...dto,
            },
            update: dto,
        });

        return buildResponse({
            message: "Notification preferences updated",
            data: preferences,
        });
    }

    /**
     * Toggle favorite asset
     */
    async toggleFavoriteAsset(
        user: User,
        currency: string
    ): Promise<ApiResponse> {
        const preferences = await this.prisma.userPreferences.findUnique({
            where: { userId: user.id },
        });

        let favoriteAssets = preferences?.favoriteAssets || [];
        const currencyUpper = currency.toUpperCase();

        if (favoriteAssets.includes(currencyUpper)) {
            // Remove from favorites
            favoriteAssets = favoriteAssets.filter((a) => a !== currencyUpper);
        } else {
            // Add to favorites
            favoriteAssets = [...favoriteAssets, currencyUpper];
        }

        const updated = await this.prisma.userPreferences.upsert({
            where: { userId: user.id },
            create: {
                userId: user.id,
                favoriteAssets,
            },
            update: { favoriteAssets },
        });

        return buildResponse({
            message: favoriteAssets.includes(currencyUpper)
                ? `${currencyUpper} added to favorites`
                : `${currencyUpper} removed from favorites`,
            data: updated,
        });
    }

    /**
     * Track quick action usage for smart sorting
     */
    async trackQuickActionUsage(
        userId: number,
        action: "buy" | "sell" | "swap" | "send" | "receive"
    ): Promise<void> {
        try {
            const preferences = await this.prisma.userPreferences.findUnique({
                where: { userId },
            });

            const currentUsage = (preferences?.quickActionUsage as Record<string, number>) || {
                buy: 0,
                sell: 0,
                swap: 0,
                send: 0,
                receive: 0,
            };

            currentUsage[action] = (currentUsage[action] || 0) + 1;

            await this.prisma.userPreferences.upsert({
                where: { userId },
                create: {
                    userId,
                    quickActionUsage: currentUsage,
                },
                update: {
                    quickActionUsage: currentUsage,
                },
            });
        } catch (error) {
            this.logger.error("Failed to track quick action usage", error);
        }
    }

    /**
     * Get sorted quick actions based on usage or manual override
     */
    async getSortedQuickActions(user: User): Promise<ApiResponse> {
        const preferences = await this.prisma.userPreferences.findUnique({
            where: { userId: user.id },
        });

        const defaultOrder = ["buy", "sell", "swap", "send", "receive"];

        // If user has manual override, use that
        if (preferences?.quickActionOrder?.length > 0) {
            return buildResponse({
                message: "Quick actions retrieved",
                data: {
                    actions: preferences.quickActionOrder,
                    isCustomOrder: true,
                },
            });
        }

        // Otherwise, sort by usage frequency
        const usage = (preferences?.quickActionUsage as Record<string, number>) || {};
        
        const sortedActions = [...defaultOrder].sort((a, b) => {
            const usageA = usage[a] || 0;
            const usageB = usage[b] || 0;
            return usageB - usageA; // Descending order
        });

        return buildResponse({
            message: "Quick actions retrieved",
            data: {
                actions: sortedActions,
                isCustomOrder: false,
                usage,
            },
        });
    }

    /**
     * Set custom quick action order
     */
    async setQuickActionOrder(
        user: User,
        order: string[]
    ): Promise<ApiResponse> {
        const validActions = ["buy", "sell", "swap", "send", "receive"];
        const filteredOrder = order.filter((a) => validActions.includes(a));

        const preferences = await this.prisma.userPreferences.upsert({
            where: { userId: user.id },
            create: {
                userId: user.id,
                quickActionOrder: filteredOrder,
            },
            update: {
                quickActionOrder: filteredOrder,
            },
        });

        return buildResponse({
            message: "Quick action order updated",
            data: preferences,
        });
    }

    /**
     * Reset quick action order to auto-sort by usage
     */
    async resetQuickActionOrder(user: User): Promise<ApiResponse> {
        const preferences = await this.prisma.userPreferences.update({
            where: { userId: user.id },
            data: {
                quickActionOrder: [],
            },
        });

        return buildResponse({
            message: "Quick action order reset to auto-sort",
            data: preferences,
        });
    }

    /**
     * Get all preferences for login response (to sync theme etc.)
     */
    async getAllPreferencesForSync(userId: number) {
        const [userPrefs, notificationPrefs] = await Promise.all([
            this.prisma.userPreferences.findUnique({
                where: { userId },
            }),
            this.prisma.notificationPreferences.findUnique({
                where: { userId },
            }),
        ]);

        return {
            preferences: userPrefs || null,
            notificationPreferences: notificationPrefs || null,
        };
    }
}
