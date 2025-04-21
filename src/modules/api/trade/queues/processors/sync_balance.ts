import { Process, Processor } from "@nestjs/bull";
import { Job } from "bull";
import { Inject } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import {
    QuidaxTradingJobOptions,
    QuidaxTradingQueue,
    TradingQueue,
} from "../interfaces";

@Processor(TradingQueue.QUIDAX_SYNC_BALANCE)
export class QuidaxTradingBalanceSyncProcessor {
    constructor(
        private prisma: PrismaService,
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService
    ) {}

    @Process(QuidaxTradingQueue.SYNC_CRYPTO_BALANCE)
    async handleSyncBalance(job: Job<QuidaxTradingJobOptions>) {
        const { user_id } = job.data;

        const user = await this.prisma.user.findUnique({
            where: { id: user_id },
            select: {
                cryptoSubAccountId: true,
                id: true,
            },
        });

        if (!user?.cryptoSubAccountId) return;

        const [wallets, quidaxWallets] = await Promise.all([
            this.prisma.cryptoWallet.findMany({
                where: { userId: user.id },
            }),
            this.quidaxService.getUserWalletList({
                user_id: user.cryptoSubAccountId,
            }),
        ]);

        const walletMap = new Map(
            (quidaxWallets.data || []).map((w) => [w.currency.toUpperCase(), w])
        );

        for (const wallet of wallets) {
            const updated = walletMap.get(wallet.assetSymbol);
            if (!updated) continue;

            await this.prisma.cryptoWallet.update({
                where: { id: wallet.id },
                data: {
                    balance: updated.balance,
                    converted_balance: updated.converted_balance,
                    lastSyncedAt: new Date(),
                },
            });
        }
    }
}
