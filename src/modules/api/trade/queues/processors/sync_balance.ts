import { Process, Processor } from "@nestjs/bull";
import { Job } from "bull";
import { Inject, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import {
    QuidaxTradingJobOptions,
    QuidaxTradingQueue,
    TradingQueue,
} from "../interfaces";

/**
 * Balance Sync Processor
 * 
 * With the Virtual Balance System:
 * - User balances are now tracked in the LedgerEntry table, NOT in assetWallet
 * - This processor now only syncs wallet METADATA (addresses, networks, etc.)
 * - The actual balance field in assetWallet is kept for backwards compatibility
 *   but should not be relied upon for balance checks
 * 
 * For platform omnibus wallet balance monitoring, see FloatConfigService.
 */
@Processor(TradingQueue.QUIDAX_SYNC_BALANCE)
export class QuidaxTradingBalanceSyncProcessor {
    private readonly logger = new Logger("QuidaxTradingBalanceSyncProcessor");

    constructor(
        private readonly prisma: PrismaService,
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService
    ) { }

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
            this.prisma.assetWallet.findMany({
                where: { userId: user.id },
            }),
            this.quidaxService.getUserWalletList({
                user_id: user.cryptoSubAccountId,
            }),
        ]);

        // Create maps for matching: primary by wallet ID, fallback by currency
        const quidaxWalletList = quidaxWallets.data || [];
        const walletMapById = new Map(
            quidaxWalletList.map((w) => [w.id, w])
        );
        const walletMapByCurrency = new Map(
            quidaxWalletList.map((w) => [w.currency.toUpperCase(), w])
        );

        for (const wallet of wallets) {
            let updated = walletMapById.get(wallet.quidaxWalletId);

            // Fallback: match by currency if quidaxWalletId is stale/synthetic
            if (!updated) {
                updated = walletMapByCurrency.get(
                    wallet.assetCurrency.toUpperCase()
                );
                if (updated) {
                    this.logger.warn(
                        `[WALLET SYNC] Repairing stale quidaxWalletId for ${wallet.assetCurrency}: ` +
                            `${wallet.quidaxWalletId} → ${updated.id}`
                    );
                }
            }

            if (!updated) {
                this.logger.debug(
                    `No wallet update data found for walletId: ${wallet.quidaxWalletId} (${wallet.assetCurrency})`
                );
                continue;
            }

            // VIRTUAL BALANCE SYSTEM:
            // We sync only wallet METADATA (addresses, networks, etc.)
            // User balances are tracked in the LedgerEntry table.
            // Balance fields are NO LONGER synced from Quidax sub-accounts.
            await this.prisma.assetWallet.update({
                where: { id: wallet.id },
                data: {
                    // Repair stale quidaxWalletId so future syncs match directly
                    quidaxWalletId: updated.id,
                    // Metadata only - balance is in LedgerEntry
                    blockchainEnabled: updated.blockchain_enabled,
                    defaultNetwork: updated.default_network,
                    isCrypto: updated.is_crypto,
                    networks: updated.networks,
                    referenceCurrency: updated.reference_currency,
                    depositAddress: updated.deposit_address,
                    destinationTag: updated.destination_tag,
                    ...(updated.deposit_address && { addressSynced: true }),
                    ...(updated.deposit_address && { isActive: true }),
                },
            });
        }
    }
}
