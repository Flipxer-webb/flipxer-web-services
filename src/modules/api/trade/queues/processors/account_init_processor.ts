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
import { Inject, Logger } from "@nestjs/common";

@Processor(TradingQueue.QUIDAX_ACCOUNT_INIT)
export class QuidaxTradingCryptoAccountInitQueueProcessor {
    private readonly logger = new Logger("CryptoAccountInit");

    constructor(
        private readonly tradingEvent: TradingEvent,
        private readonly prisma: PrismaService,
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService,
        private readonly tradingService: TradingService
    ) {}

    @Process(QuidaxTradingQueue.TRADING_ACCOUNT_INIT)
    async processQuidaxAccountCreation(options: Job<QuidaxTradingJobOptions>) {
        const { user_id } = options.data;
        this.logger.log(`Job received | ${JSON.stringify({ user_id })}`);

        try {
            const user = await this.prisma.user.findUnique({
                where: { id: user_id },
            });

            if (!user) {
                this.logger.warn(
                    `User not found | ${JSON.stringify({ user_id })}`
                );
                return "user_not_found";
            }

            // Create sub-account
            const result = await this.quidaxService.createOrFindSubAccount({
                email: user.email,
                first_name: user.firstName,
                last_name: user.lastName,
            });

            this.logger.log(
                `Sub-account creation result | ${JSON.stringify({
                    status: result?.status,
                    dataId: result?.data?.id,
                })}`
            );

            if (result.status !== "success") {
                this.logger.error(
                    `Sub-account creation failed | ${JSON.stringify({
                        status: result.status,
                    })}`
                );
                return "subaccount_failed";
            }

            await this.prisma.user.update({
                where: { id: user.id },
                data: { cryptoSubAccountId: result.data.id },
            });

            this.logger.log(
                `Sub-account ID stored | ${JSON.stringify({
                    userId: user.id,
                    subAccountId: result.data.id,
                })}`
            );

            const currencies = ["btc", "usdt", "usdc"];

            const addressCreationResults = await Promise.allSettled(
                currencies.map(async (currency) => {
                    this.logger.log(
                        `Ensuring wallet payment addresses | ${JSON.stringify({
                            userId: user.id,
                            currency,
                        })}`
                    );

                    try {
                        const addresses =
                            await this.tradingService.ensureWalletPaymentAddresses({
                                userId: user.id,
                                cryptoSubAccountId: result.data.id,
                                assetSymbol: currency.toUpperCase(),
                            });

                        this.logger.log(
                            `Address creation response | ${JSON.stringify({
                                userId: user.id,
                                currency,
                                createdCount: addresses.length,
                                addresses,
                            })}`
                        );

                        return addresses;
                    } catch (error) {
                        this.logger.error(
                            `Address creation error | ${JSON.stringify({
                                userId: user.id,
                                currency,
                                error: error?.message,
                            })}`
                        );

                        throw error;
                    }
                })
            );

            const hasCreatedAddress = addressCreationResults.some(
                (result) => result.status === "fulfilled" && result.value.length
            );

            if (!hasCreatedAddress) {
                this.logger.warn("No wallet addresses were successfully created.");
                return "no_wallets_created";
            }

            addressCreationResults
                .filter(
                    (result): result is PromiseRejectedResult =>
                        result.status === "rejected"
                )
                .forEach((error) =>
                    this.logger.error(
                        `Wallet address creation failed | ${JSON.stringify({
                            reason: error.reason,
                        })}`
                    )
                );

            return true;
        } catch (error) {
            this.logger.error(
                `processQuidaxAccountCreation failed | ${error?.message}`,
                error?.stack
            );
            return false;
        }
    }
}
