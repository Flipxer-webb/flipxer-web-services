import { Inject, Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { Mutex } from "async-mutex";
import { PrismaService } from "@/modules/core/prisma/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { ITradingProvider } from "@/modules/factory/trading/interfaces/trading-provider.interface";
import { AssetWallet, Prisma } from "@prisma/client";

@Injectable()
export class SweepWorkerService {
    private readonly logger = new Logger(SweepWorkerService.name);
    private readonly mutex = new Mutex();

    constructor(
        private readonly prisma: PrismaService,
        @Inject(TradingInjectionToken.TRADING_PROVIDER)
        private readonly tradingService: ITradingProvider
    ) { }

    /**
     * Cron Job: Retry Failed Sweeps
     * Runs every 5 minutes to sweep any funds pending in sub-accounts.
     */
    @Cron("*/5 * * * *")
    async retryFailedSweeps() {
        if (this.mutex.isLocked()) {
            this.logger.debug("Sweep job already running, skipping...");
            return;
        }

        const release = await this.mutex.acquire();
        try {
            // Find wallets with pending sweeps
            // We verify pendingSweepBalance > 0 AND balance > 0 (sanity check)
            const pendingWallets = await this.prisma.assetWallet.findMany({
                where: {
                    pendingSweepBalance: { gt: 0 },
                },
                take: 50, // Process in batches
                include: {
                    user: true,
                },
            });

            if (pendingWallets.length === 0) return;

            this.logger.log(`Found ${pendingWallets.length} wallets with pending sweeps. Processing...`);

            for (const wallet of pendingWallets) {
                await this.processSweep(wallet);
            }

        } catch (error) {
            this.logger.error("Error in Sweep Worker:", error);
        } finally {
            release();
        }
    }

    private async processSweep(wallet: AssetWallet & { user: any }) {
        const { user, assetCurrency, pendingSweepBalance } = wallet;

        if (!user.cryptoSubAccountId) {
            this.logger.warn(`User ${user.id} has pending sweep but no sub-account ID.`);
            return;
        }

        try {
            this.logger.log(`Sweeping ${pendingSweepBalance} ${assetCurrency} for User ${user.id} from sub-account...`);

            // Execute Sweep (Sub -> Master)
            // We assume the provider handles the "internal" nature or we pass a flag if needed.
            // Using internalTransfer as defined in our interface.
            const transferResult = await this.tradingService.internalTransfer({
                userId: user.cryptoSubAccountId, // From Sub-account
                currency: assetCurrency.toLowerCase(),
                amount: pendingSweepBalance.toString(),
            });

            if (transferResult.status === 'success') {
                // Atomic Update: Clear pending balance
                await this.prisma.assetWallet.update({
                    where: { id: wallet.id },
                    data: {
                        pendingSweepBalance: { decrement: pendingSweepBalance }, // Reduce by what we swept
                        lastSyncedAt: new Date(),
                    },
                });
                this.logger.log(`Sweep successful for User ${user.id}.`);
            } else {
                this.logger.error(`Sweep failed for User ${user.id}: ${transferResult.message}`);
            }

        } catch (error) {
            this.logger.error(`Exception sweeping wallet ${wallet.id}: ${error.message}`);
        }
    }
}
