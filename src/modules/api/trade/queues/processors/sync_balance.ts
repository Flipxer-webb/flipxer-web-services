import { Process, Processor } from "@nestjs/bull";
import { Job, Queue } from "bull";
import { InjectQueue } from "@nestjs/bull";
import { Inject, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { CryptoWalletStatus, NetworkTypes } from "@prisma/client";
import {
    QuidaxTradingJobOptions,
    QuidaxTradingQueue,
    TradingQueue,
} from "../interfaces";
import {
    NETWORK_ALIAS_MAP,
    NETWORK_SEGMENT_SPLITTER,
} from "../../constants";
import { withQuidaxThrottleGuard } from "./quidax-throttle-guard";

const supportedNetworkSet = new Set<string>(Object.values(NetworkTypes));

function normalizeNetwork(network?: string | null): NetworkTypes | null {
    if (!network) {
        return null;
    }

    const trimmed = network.trim().toLowerCase();

    if (!trimmed) {
        return null;
    }

    const directMatch =
        NETWORK_ALIAS_MAP[trimmed] ||
        (supportedNetworkSet.has(trimmed) ? (trimmed as NetworkTypes) : null);

    if (directMatch) {
        return directMatch;
    }

    const segments = trimmed.split(NETWORK_SEGMENT_SPLITTER).reverse();

    for (const segment of segments) {
        if (!segment) {
            continue;
        }

        const alias =
            NETWORK_ALIAS_MAP[segment] ||
            (supportedNetworkSet.has(segment)
                ? (segment as NetworkTypes)
                : null);

        if (alias) {
            return alias;
        }
    }

    return null;
}

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
        private readonly quidaxService: QuidaxService,
        @InjectQueue(TradingQueue.QUIDAX_SYNC_BALANCE)
        private readonly syncBalanceQueue: Queue<QuidaxTradingJobOptions>
    ) { }

    private resolveProviderWallet(
        wallet: any,
        walletMapById: Map<string, any>,
        walletMapByCurrency: Map<string, any>
    ) {
        let updated = walletMapById.get(wallet.quidaxWalletId);

        if (!updated) {
            updated = walletMapByCurrency.get(wallet.assetCurrency.toUpperCase());

            if (updated) {
                this.logger.warn(
                    `[WALLET SYNC] Repairing stale quidaxWalletId for ${wallet.assetCurrency}: ` +
                        `${wallet.quidaxWalletId} → ${updated.id}`
                );
            }
        }

        return updated;
    }

    private resolveAddressMetadata(
        wallet: any,
        updated: any,
        activeAddressMap: Map<string, any>
    ) {
        const normalizedDefaultNetwork = normalizeNetwork(
            updated.default_network || wallet.defaultNetwork
        );
        const activeDefaultNetworkAddress = normalizedDefaultNetwork
            ? activeAddressMap.get(
                `${wallet.assetCurrency.toUpperCase()}:${normalizedDefaultNetwork}`
            )
            : undefined;
        const depositAddress =
            updated.deposit_address ?? activeDefaultNetworkAddress?.address ?? null;

        return {
            depositAddress,
            destinationTag:
                updated.destination_tag ??
                activeDefaultNetworkAddress?.destination_tag ??
                null,
            addressSynced: Boolean(depositAddress),
            isActive: Boolean(depositAddress),
        };
    }

    @Process(QuidaxTradingQueue.SYNC_CRYPTO_BALANCE)
    async handleSyncBalance(job: Job<QuidaxTradingJobOptions>) {
        return withQuidaxThrottleGuard(
            this.syncBalanceQueue,
            this.logger,
            () => this.runSyncBalance(job)
        );
    }

    private async runSyncBalance(job: Job<QuidaxTradingJobOptions>) {
        const { user_id } = job.data;

        const user = await this.prisma.user.findUnique({
            where: { id: user_id },
            select: {
                cryptoSubAccountId: true,
                id: true,
            },
        });

        if (!user?.cryptoSubAccountId) return;

        const [wallets, quidaxWallets, activeWalletAddresses] = await Promise.all([
            this.prisma.assetWallet.findMany({
                where: { userId: user.id },
            }),
            this.quidaxService.getUserWalletList({
                user_id: user.cryptoSubAccountId,
            }),
            this.prisma.cryptoWalletAddress.findMany({
                where: {
                    userId: user.id,
                    status: CryptoWalletStatus.ACTIVE,
                    address: { not: null },
                },
                select: {
                    id: true,
                    assetSymbol: true,
                    network: true,
                    address: true,
                    destination_tag: true,
                    updatedAt: true,
                },
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
        const activeAddressMap = new Map<string, (typeof activeWalletAddresses)[number]>();

        for (const walletAddress of activeWalletAddresses) {
            if (!walletAddress.network) {
                continue;
            }

            const key = `${walletAddress.assetSymbol}:${walletAddress.network}`;
            const existing = activeAddressMap.get(key);

            if (
                !existing ||
                walletAddress.updatedAt > existing.updatedAt ||
                (walletAddress.updatedAt.getTime() === existing.updatedAt.getTime() &&
                    walletAddress.id > existing.id)
            ) {
                activeAddressMap.set(key, walletAddress);
            }
        }

        for (const wallet of wallets) {
            const updated = this.resolveProviderWallet(
                wallet,
                walletMapById,
                walletMapByCurrency
            );

            if (!updated) {
                this.logger.debug(
                    `No wallet update data found for walletId: ${wallet.quidaxWalletId} (${wallet.assetCurrency})`
                );
                continue;
            }
            const addressMetadata = this.resolveAddressMetadata(
                wallet,
                updated,
                activeAddressMap
            );

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
                    depositAddress: addressMetadata.depositAddress,
                    destinationTag: addressMetadata.destinationTag,
                    addressSynced: addressMetadata.addressSynced,
                    isActive: addressMetadata.isActive,
                },
            });
        }
    }
}
