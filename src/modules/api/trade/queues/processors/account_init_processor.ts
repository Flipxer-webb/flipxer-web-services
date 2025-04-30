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
import { NetworkTypes } from "@prisma/client";

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

            if (!user) return "user_not_found";

            // Create sub-account
            const result = await this.quidaxService.createSubAccount({
                email: user.email,
                first_name: user.firstName,
                last_name: user.lastName,
            });

            if (result.status !== "success") {
                return "subaccount_failed";
            }

            await this.prisma.$transaction(async (tx) => {
                await tx.user.update({
                    where: { id: user.id },
                    data: { cryptoSubAccountId: result.data.id },
                });

                for (const currency of [
                    "btc",
                    "eth",
                    "usdt",
                    "bnb",
                    "xrp",
                    "sol",
                    "ada",
                    "doge",
                    "ton",
                    "ltc",
                ]) {
                    const wallet =
                        await this.quidaxService.createPaymentAddress({
                            user_id: result.data.id,
                            currency,
                            //network: NetworkTypes.trc20,
                        });

                    await tx.cryptoWalletAddress.create({
                        data: {
                            assetSymbol: currency.toUpperCase(),
                            walletAddressId: wallet.data.id,
                            userId: user.id,
                            network: wallet.data.network as NetworkTypes,
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
