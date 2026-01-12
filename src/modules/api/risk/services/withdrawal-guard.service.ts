import { Injectable, Logger, Inject } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { VolatilityMonitorService } from "./volatility-monitor.service";
import { LiveCoinWatchService } from "@/modules/factory/trading/providers/livecoinwatch/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { OrderCategory, OrderStatus } from "@prisma/client";

@Injectable()
export class WithdrawalGuardService {
    private readonly logger = new Logger(WithdrawalGuardService.name);
    // Limits
    private readonly MAX_GLOBAL_HOURLY_OUTFLOW_USD = 50000; // $50k/hr platform wide
    private readonly MAX_USER_DAILY_WITHDRAWAL_USD = 10000; // $10k/day per user

    constructor(
        private readonly prisma: PrismaService,
        private readonly volatilityService: VolatilityMonitorService,
        @Inject(TradingInjectionToken.LIVECOINWATCH)
        private readonly lcwService: LiveCoinWatchService
    ) { }

    async checkWithdrawalRisk(userId: number, asset: string, amount: number): Promise<{ safe: boolean; reason?: string }> {
        // Calculate USD amount first
        const priceMap = await this.lcwService.getBatchPrices([asset]);
        const price = priceMap[asset.toLowerCase()] || 0;
        const amountUsd = amount * price;

        // 1. Check Volatility
        const volatility = await this.volatilityService.isVolatile(asset);
        if (volatility?.isVolatile) {
            return { safe: false, reason: `Asset ${asset} is currently volatile: ${volatility.reason}` };
        }

        // 2. Check User Daily Limit
        const userDailyTotal = await this.getUser24hWithdrawalTotal(userId);
        if (userDailyTotal + amountUsd > this.MAX_USER_DAILY_WITHDRAWAL_USD) {
            return { safe: false, reason: `Exceeds daily withdrawal limit of $${this.MAX_USER_DAILY_WITHDRAWAL_USD}` };
        }

        // 3. Check Global Hourly Outflow
        const globalHourlyTotal = await this.getGlobalHourlyOutflow();
        if (globalHourlyTotal + amountUsd > this.MAX_GLOBAL_HOURLY_OUTFLOW_USD) {
            // Trigger Admin Alert (TODO)
            this.logger.error(`GLOBAL RISK: Hourly outflow $${globalHourlyTotal + amountUsd} exceeds limit $${this.MAX_GLOBAL_HOURLY_OUTFLOW_USD}`);
            return { safe: false, reason: "Platform temporary safety limit reached. Please try again later." };
        }

        return { safe: true };
    }

    private async getUser24hWithdrawalTotal(userId: number): Promise<number> {
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

        // Fetch past withdrawal/send orders
        const orders = await this.prisma.order.findMany({
            where: {
                userId,
                orderCategory: OrderCategory.SEND,
                createdAt: { gte: yesterday },
                status: { not: OrderStatus.failed } // Count pending and completed
            },
            select: { currency: true, amount: true }
        });

        if (orders.length === 0) return 0;

        // Group by currency to minimize API calls
        const totalsByCurrency: Record<string, number> = {};
        for (const order of orders) {
            const currency = order.currency.toUpperCase();
            totalsByCurrency[currency] = (totalsByCurrency[currency] || 0) + parseFloat(order.amount.toString());
        }

        return this.calculateUsdTotal(totalsByCurrency);
    }

    private async getGlobalHourlyOutflow(): Promise<number> {
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

        const orders = await this.prisma.order.findMany({
            where: {
                orderCategory: OrderCategory.SEND,
                createdAt: { gte: oneHourAgo },
                status: { not: OrderStatus.failed }
            },
            select: { currency: true, amount: true }
        });

        if (orders.length === 0) return 0;

        const totalsByCurrency: Record<string, number> = {};
        for (const order of orders) {
            const currency = order.currency.toUpperCase();
            totalsByCurrency[currency] = (totalsByCurrency[currency] || 0) + parseFloat(order.amount.toString());
        }

        return this.calculateUsdTotal(totalsByCurrency);
    }

    private async calculateUsdTotal(totalsByCurrency: Record<string, number>): Promise<number> {
        let totalUsd = 0;
        const currencies = Object.keys(totalsByCurrency);

        // Fetch current prices in batch
        const prices = await this.lcwService.getBatchPrices(currencies);

        for (const currency of currencies) {
            const price = prices[currency.toLowerCase()] || 0;
            totalUsd += totalsByCurrency[currency] * price;
        }

        return totalUsd;
    }
}
