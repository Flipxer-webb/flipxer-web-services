import { Process, Processor } from "@nestjs/bull";
import {
    TradingQueue,
    QuidaxTradingQueue,
    QuidaxTradingJobOptions,
} from "../interfaces";
import { Job } from "bull";
import { TradingEvent } from "../../events";
import { PrismaService } from "@/modules/core/prisma/services";
import { TradingService } from "../../services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import { Inject } from "@nestjs/common";

@Processor(TradingQueue.QUIDAX_ACCOUNT_INIT)
export class QuidaxTradingCryptoAccountInitQueueProcessor {
    constructor(
        private tradingEvent: TradingEvent,
        private prisma: PrismaService,
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService,
        private tradingService: TradingService
    ) {}

    @Process(QuidaxTradingQueue.TRADING_ACCOUNT_INIT)
    async processQuidaxAccountCreation(options: Job<QuidaxTradingJobOptions>) {
        const { user_id } = options.data;
        try {
            const user = await this.prisma.user.findUnique({
                where: { id: user_id },
            });

            if (!user) return;

            // Create sub-account
            const result = await this.quidaxService.createSubAccount({
                email: user.email,
                first_name: user.firstName,
                last_name: user.lastName,
            });

            if (result.status !== "success") return false;

            await this.prisma.$transaction(async (tx) => {
                await tx.user.update({
                    where: { id: user.id },
                    data: { cryptoSubAccountId: result.data.id },
                });

                for (const currency of ["btc", "usdt"]) {
                    const wallet =
                        await this.quidaxService.createPaymentAddress({
                            user_id: result.data.id,
                            currency,
                        });

                    await tx.cryptoWallet.create({
                        data: {
                            assetSymbol: currency.toUpperCase(),
                            walletId: wallet.data.id,
                            userId: user.id,
                        },
                    });
                }
            });

            return true;
        } catch (error) {
            switch (true) {
                default: {
                    return false;
                }
            }
        }
    }
}
