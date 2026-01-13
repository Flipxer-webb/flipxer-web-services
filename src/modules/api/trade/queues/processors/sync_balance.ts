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
            this.prisma.assetWallet.findMany({
                where: { userId: user.id },
            }),
            this.quidaxService.getUserWalletList({
                user_id: user.cryptoSubAccountId,
            }),
        ]);

        // Create a map using Quidax wallet ID (wallet.id) as the key
        const walletMap = new Map(
            (quidaxWallets.data || []).map((w) => [w.id, w])
        );

        for (const wallet of wallets) {
            const updated = walletMap.get(wallet.quidaxWalletId);

            if (!updated) {
                this.logger.warn(
                    `No wallet update data found for walletId: ${wallet.quidaxWalletId}`
                );
                continue;
            }

            // VIRTUAL BALANCE SYSTEM:
            // We sync metadata (addresses, networks, etc.) but NOT the balance.
            // User balances are tracked in the LedgerEntry table.
            // The assetWallet.balance field is kept for backwards compatibility
            // during the transition period only.
            await this.prisma.assetWallet.update({
                where: { id: wallet.id },
                data: {
                    // NOTE: balance, locked, staked, convertedBalance are updated
                    // for backwards compatibility only. The source of truth for
                    // user balances is now the LedgerEntry table.
                    balance: updated.balance,
                    locked: updated.locked,
                    staked: updated.staked,
                    convertedBalance: updated.converted_balance,
                    // Metadata - still needed
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
