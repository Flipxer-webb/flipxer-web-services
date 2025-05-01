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

            await this.prisma.user.update({
                where: { id: user.id },
                data: { cryptoSubAccountId: result.data.id },
            });

            const currencies = [
                "btc",
                "eth",
                "usdt",
                "bnb",
                "xrp",
                "ada",
                "doge",
                "link",
                "ltc",
            ];

            // Let failed address generations throw and be caught by allSettled
            const settledResults = await Promise.allSettled(
                currencies.map((currency) =>
                    this.quidaxService
                        .createPaymentAddress({
                            user_id: result.data.id,
                            currency,
                        })
                        .then((wallet) => ({
                            assetSymbol: currency.toUpperCase(),
                            walletAddressId: wallet.data.id,
                            network: wallet.data.network as NetworkTypes,
                        }))
                )
            );

            // Only keep successful ones
            const walletResponses = settledResults
                .filter(
                    (
                        res
                    ): res is PromiseFulfilledResult<{
                        assetSymbol: string;
                        walletAddressId: string;
                        network: NetworkTypes;
                    }> => res.status === "fulfilled"
                )
                .map((res) => res.value);

            if (!walletResponses.length) {
                console.warn("No wallet addresses were successfully created.");
                return "no_wallets_created";
            }

            await this.prisma.$transaction(
                async (tx) => {
                    for (const walletData of walletResponses) {
                        await tx.cryptoWalletAddress.create({
                            data: {
                                assetSymbol: walletData.assetSymbol,
                                walletAddressId: walletData.walletAddressId,
                                userId: user.id,
                                network: walletData.network,
                            },
                        });
                    }
                },
                {
                    timeout: 20000,
                }
            );

            return true;
        } catch (error) {
            console.error("processQuidaxAccountCreation failed:", error);
            return false;
        }
    }
}
