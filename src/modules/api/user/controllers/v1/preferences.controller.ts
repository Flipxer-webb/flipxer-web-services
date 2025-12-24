import {
    Controller,
    Get,
    Patch,
    Post,
    Body,
    Param,
    UseGuards,
} from "@nestjs/common";
import {
    ApiTags,
    ApiOperation,
    ApiBearerAuth,
    ApiBody,
} from "@nestjs/swagger";
import {
    PreferencesService,
    UpdateUserPreferencesDto,
    UpdateNotificationPreferencesDto,
} from "../../services/preferences.service";
import {
    AuthGuard,
    CountryBlockGuard,
    EnabledAccountGuard,
} from "@/modules/api/auth/guard";
import { User } from "../../decorators";
import { User as UserModel } from "@prisma/client";

@ApiTags("preferences")
@Controller({
    path: "user/preferences",
})
@UseGuards(CountryBlockGuard, AuthGuard, EnabledAccountGuard)
export class PreferencesController {
    constructor(private readonly preferencesService: PreferencesService) {}

    @ApiOperation({ summary: "Get user preferences" })
    @ApiBearerAuth("access-token")
    @Get()
    async getPreferences(@User() user: UserModel) {
        return await this.preferencesService.getUserPreferences(user);
    }

    @ApiOperation({ summary: "Update user preferences" })
    @ApiBearerAuth("access-token")
    @ApiBody({
        schema: {
            type: "object",
            properties: {
                theme: { type: "string", enum: ["light", "dark", "system"] },
                defaultFiatCurrency: { type: "string", example: "NGN" },
                favoriteAssets: { type: "array", items: { type: "string" } },
                quickActionOrder: { type: "array", items: { type: "string" } },
                hideZeroBalances: { type: "boolean" },
                dashboardLayout: { type: "object" },
            },
        },
    })
    @Patch()
    async updatePreferences(
        @User() user: UserModel,
        @Body() dto: UpdateUserPreferencesDto
    ) {
        return await this.preferencesService.updateUserPreferences(user, dto);
    }

    @ApiOperation({ summary: "Get notification preferences" })
    @ApiBearerAuth("access-token")
    @Get("notifications")
    async getNotificationPreferences(@User() user: UserModel) {
        return await this.preferencesService.getNotificationPreferences(user);
    }

    @ApiOperation({ summary: "Update notification preferences" })
    @ApiBearerAuth("access-token")
    @ApiBody({
        schema: {
            type: "object",
            properties: {
                emailTransactions: { type: "boolean" },
                emailMarketing: { type: "boolean" },
                emailSecurityAlerts: { type: "boolean" },
                pushTransactions: { type: "boolean" },
                pushPriceAlerts: { type: "boolean" },
                pushSecurityAlerts: { type: "boolean" },
                pushMarketing: { type: "boolean" },
                quietHoursEnabled: { type: "boolean" },
                quietHoursStart: { type: "string", example: "22:00" },
                quietHoursEnd: { type: "string", example: "07:00" },
            },
        },
    })
    @Patch("notifications")
    async updateNotificationPreferences(
        @User() user: UserModel,
        @Body() dto: UpdateNotificationPreferencesDto
    ) {
        return await this.preferencesService.updateNotificationPreferences(user, dto);
    }

    @ApiOperation({ summary: "Toggle favorite asset" })
    @ApiBearerAuth("access-token")
    @Post("favorites/:currency")
    async toggleFavorite(
        @User() user: UserModel,
        @Param("currency") currency: string
    ) {
        return await this.preferencesService.toggleFavoriteAsset(user, currency);
    }

    @ApiOperation({ summary: "Get sorted quick actions based on usage" })
    @ApiBearerAuth("access-token")
    @Get("quick-actions")
    async getQuickActions(@User() user: UserModel) {
        return await this.preferencesService.getSortedQuickActions(user);
    }

    @ApiOperation({ summary: "Track quick action usage" })
    @ApiBearerAuth("access-token")
    @ApiBody({
        schema: {
            type: "object",
            properties: {
                action: { type: "string", example: "buy" },
            },
            required: ["action"],
        },
    })
    @Post("quick-actions/track")
    async trackQuickAction(
        @User() user: UserModel,
        @Body("action") action: string
    ) {
        return await this.preferencesService.trackQuickActionUsage(user.id, action as any);
    }

    @ApiOperation({ summary: "Set custom quick action order" })
    @ApiBearerAuth("access-token")
    @ApiBody({
        schema: {
            type: "object",
            properties: {
                order: {
                    type: "array",
                    items: { type: "string" },
                    example: ["buy", "swap", "sell", "send", "receive"],
                },
            },
        },
    })
    @Patch("quick-actions")
    async setQuickActionOrder(
        @User() user: UserModel,
        @Body("order") order: string[]
    ) {
        return await this.preferencesService.setQuickActionOrder(user, order);
    }

    @ApiOperation({ summary: "Reset quick action order to auto-sort" })
    @ApiBearerAuth("access-token")
    @Post("quick-actions/reset")
    async resetQuickActionOrder(@User() user: UserModel) {
        return await this.preferencesService.resetQuickActionOrder(user);
    }
}
