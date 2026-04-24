import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import { GetUserWalletResponse, IPaymentAddress } from "@/libs/quidax";
import {
    CryptoWalletAddress,
    CryptoWalletStatus,
    NetworkTypes,
} from "@prisma/client";
import { buildResponse } from "@/utils/api-response-util";
import {
    GeneralTransactionException,
    OutOfRangeException,
} from "../errors";
import { TradeHelpersService } from "./trade-helpers.service";
import {
    SUPPORTED_ASSETS,
    DEFAULT_TRANSACTION_TIMEOUT_MS,
} from "../constants";
import {
    GetWalletDto,
    GetWalletAddressesDto,
    VerifyWalletAddressDto,
    InitiateWalletCreationDto,
} from "../dtos";
import { UserNotFoundException } from "../../user";

/**
 * Wallet Address Service
 * 
 * Handles all wallet address management operations including:
 * - Creating and managing crypto wallet addresses
 * - Syncing wallet balances with Quidax
 * - Managing payment addresses across networks
 */
@Injectable()
export class WalletAddressService {
    private readonly logger = new Logger("WalletAddressService");

    constructor(
        private readonly prisma: PrismaService,
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService,
        private readonly tradeHelpers: TradeHelpersService
    ) { }

    /**
     * Logs wallet-related operations with structured data
     */
    private logWalletFlow(step: string, payload: Record<string, unknown> = {}) {
        const safePayload = this.tradeHelpers.safeJsonStringify(payload);
        this.logger.debug(`[WalletFlow] ${step} | ${safePayload}`);
    }

    /**
     * Syncs a user's wallet balance with Quidax for a specific currency
     * 
     * @param userId - The user's database ID
     * @param currency - The cryptocurrency symbol (e.g., "BTC", "ETH")
     */
    async syncWallet(userId: number, currency: string): Promise<void> {
        try {
            const user = await this.prisma.user.findUnique({
                where: { id: userId },
                select: { cryptoSubAccountId: true },
            });

            if (!user?.cryptoSubAccountId) return;

            const { data } = await this.quidaxService.getUserWallet({
                user_id: user.cryptoSubAccountId,
                currency: currency.toLowerCase(),
            });

            if (data) {
                // VIRTUAL BALANCE SYSTEM: Only sync metadata, not balance
                // User balances are tracked in LedgerEntry table
                await this.prisma.assetWallet.update({
                    where: {
                        userId_assetCurrency: {
                            userId: userId,
                            assetCurrency: currency.toUpperCase(),
                        },
                    },
                    data: {
                        // Metadata only - balance is in LedgerEntry
                        depositAddress: data.deposit_address,
                        destinationTag: data.destination_tag,
                        defaultNetwork: data.default_network,
                        networks: data.networks,
                        blockchainEnabled: data.blockchain_enabled,
                        updatedAt: new Date(),
                    },
                });
            }
        } catch (error) {
            this.logger.error(
                `Failed to sync wallet for ${currency}: ${error.message}`
            );
        }
    }

    /**
     * Extracts a map of deposit-enabled networks from wallet data
     * 
     * @param wallet - The wallet response from Quidax
     * @returns Map of normalized network types to provider network identifiers
     */
    extractDepositEnabledNetworkMap(
        wallet: GetUserWalletResponse
    ): Map<NetworkTypes, string> {
        this.logWalletFlow("extractDepositEnabledNetworkMap:start", {
            currency: wallet.currency,
            defaultNetwork: wallet.default_network,
            networkCount: wallet.networks?.length ?? 0,
        });
        const depositEnabledMap = new Map<NetworkTypes, string>();

        const register = (candidate?: string | null) => {
            if (!candidate?.trim()) {
                this.logWalletFlow(
                    "extractDepositEnabledNetworkMap:skip_empty",
                    { candidate }
                );
                return;
            }

            const normalized = this.tradeHelpers.normalizeNetworkInput(candidate);

            if (!normalized) {
                this.logWalletFlow(
                    "extractDepositEnabledNetworkMap:unsupported_network",
                    { candidate }
                );
                return;
            }

            depositEnabledMap.set(normalized, candidate.trim().toLowerCase());
            this.logWalletFlow("extractDepositEnabledNetworkMap:registered", {
                normalized,
                providerValue: candidate.trim().toLowerCase(),
            });
        };

        const networks = wallet.networks ?? [];

        if (wallet.default_network) {
            const defaultNetworkInfo = networks.find(
                (network) => network.id === wallet.default_network
            );

            if (!defaultNetworkInfo || defaultNetworkInfo.deposits_enabled) {
                register(wallet.default_network);
            }
        }

        for (const network of networks) {
            if (!network.deposits_enabled) {
                this.logWalletFlow(
                    "extractDepositEnabledNetworkMap:skip_deposit_disabled",
                    { networkId: network.id }
                );
                continue;
            }

            register(network.id);
        }

        this.logWalletFlow("extractDepositEnabledNetworkMap:complete", {
            registeredCount: depositEnabledMap.size,
        });
        return depositEnabledMap;
    }

    /**
     * Ensures wallet payment addresses exist for the specified networks.
     * Creates new addresses via Quidax if they don't exist.
     *
     * @param options - Configuration for address creation
     * @returns Array of created or existing wallet addresses
     */
    async ensureWalletPaymentAddresses(options: {
        userId: number;
        cryptoSubAccountId: string;
        assetSymbol: string;
        requestedNetworks?: string[];
        walletData?: GetUserWalletResponse;
    }): Promise<CryptoWalletAddress[]> {
        const { userId, cryptoSubAccountId, assetSymbol } = options;
        const assetSymbolUpper = assetSymbol.toUpperCase();
        const currency = assetSymbol.toLowerCase();

        this.logWalletFlow("ensureWalletPaymentAddresses:start", {
            userId,
            cryptoSubAccountId,
            assetSymbol: assetSymbolUpper,
            requestedNetworks: options.requestedNetworks,
            hasWalletData: Boolean(options.walletData),
        });

        // Validate asset is supported
        if (!SUPPORTED_ASSETS.has(assetSymbolUpper)) {
            this.logWalletFlow("ensureWalletPaymentAddresses:skip_asset", {
                assetSymbol: assetSymbolUpper,
            });
            return [];
        }

        // Fetch wallet data from provider
        const walletResponse = await this.getOrFetchWalletResponse(
            options.walletData,
            cryptoSubAccountId,
            currency,
        );
        if (!walletResponse) return [];

        // Get deposit-enabled networks
        const depositEnabledNetworkMap =
            this.extractDepositEnabledNetworkMap(walletResponse);
        if (!depositEnabledNetworkMap.size) {
            this.logWalletFlow(
                "ensureWalletPaymentAddresses:no_deposit_enabled_network",
                { currency, cryptoSubAccountId }
            );
            return [];
        }

        // Determine target networks to create
        const targetNetworks = await this.determineTargetNetworks({
            depositEnabledNetworkMap,
            requestedNetworks: options.requestedNetworks,
            currency: walletResponse.currency,
            cryptoSubAccountId,
        });
        if (!targetNetworks.length) return [];

        // Get existing addresses and build network set
        const { existingNetworkSet } =
            await this.buildExistingNetworkContext(
                userId,
                assetSymbolUpper,
                walletResponse,
                depositEnabledNetworkMap,
            );

        // Backfill addresses from provider and apply fallback
        const providerAddressMap = await this.fetchProviderAddressMap(
            cryptoSubAccountId,
            currency
        );
        const backfilledProviderAddresses = await this.backfillFromProviderAddresses({
            providerAddressMap,
            targetNetworks,
            existingNetworkSet,
            userId,
            assetSymbolUpper,
        });

        await this.applyWalletAddressFallback(
            userId,
            assetSymbolUpper,
            walletResponse,
        );

        // Calculate networks to create
        const networksToCreate = targetNetworks.filter(
            (network) => !existingNetworkSet.has(network)
        );

        this.logWalletFlow("ensureWalletPaymentAddresses:networks_to_create", {
            networksToCreate,
        });

        // Early exit if all networks already exist
        if (!networksToCreate.length) {
            return await this.getExistingWalletAddresses(userId, assetSymbolUpper);
        }

        // Clean up FAILED records before creating new ones
        await this.deleteFailedRecordsForNetworks(
            userId,
            assetSymbolUpper,
            networksToCreate
        );

        // Create new addresses via Quidax
        const createdAddresses = await this.createAndPersistAddresses({
            networksToCreate,
            depositEnabledNetworkMap,
            cryptoSubAccountId,
            currency,
            userId,
            assetSymbolUpper,
            backfilledProviderAddresses,
        });

        this.logWalletFlow("ensureWalletPaymentAddresses:complete", {
            createdAddresses: createdAddresses.map((address) => ({
                id: address.id,
                network: address.network,
            })),
        });

        return createdAddresses;
    }

    /**
     * Fetches wallet response, using provided data or fetching from Quidax
     */
    private async getOrFetchWalletResponse(
        providedWalletData: GetUserWalletResponse | undefined,
        cryptoSubAccountId: string,
        currency: string
    ): Promise<GetUserWalletResponse | null> {
        const walletResponse =
            providedWalletData ??
            (
                await this.quidaxService.getUserWallet({
                    user_id: cryptoSubAccountId,
                    currency,
                })
            ).data;

        if (!walletResponse) {
            this.logWalletFlow(
                "ensureWalletPaymentAddresses:no_wallet_response",
                { currency, cryptoSubAccountId }
            );
            return null;
        }

        return walletResponse;
    }

    /**
     * Determines target networks based on deposit availability and user requests
     */
    private async determineTargetNetworks(options: {
        depositEnabledNetworkMap: Map<NetworkTypes, string>;
        requestedNetworks?: string[];
        currency: string;
        cryptoSubAccountId: string;
    }): Promise<NetworkTypes[]> {
        let targetNetworks = Array.from(options.depositEnabledNetworkMap.keys());

        this.logWalletFlow("ensureWalletPaymentAddresses:initial_targets", {
            targetNetworks,
        });

        if (options.requestedNetworks?.length) {
            targetNetworks = this.validateRequestedNetworks(
                options.requestedNetworks,
                options.depositEnabledNetworkMap,
                options.currency,
            );
            this.logWalletFlow(
                "ensureWalletPaymentAddresses:filtered_requested_networks",
                { targetNetworks }
            );
        }

        if (!targetNetworks.length) {
            this.logWalletFlow(
                "ensureWalletPaymentAddresses:no_target_networks_after_filter",
                { currency: options.currency, cryptoSubAccountId: options.cryptoSubAccountId }
            );
        }

        return targetNetworks;
    }

    /**
     * Builds context of existing addresses and default network
     */
    private async buildExistingNetworkContext(
        userId: number,
        assetSymbolUpper: string,
        walletResponse: GetUserWalletResponse,
        depositEnabledNetworkMap: Map<NetworkTypes, string>,
    ): Promise<{
        existingNetworkSet: Set<NetworkTypes>;
        defaultNetworkNormalized: NetworkTypes | null;
    }> {
        const existingAddresses = await this.prisma.cryptoWalletAddress.findMany({
            where: {
                userId,
                assetSymbol: assetSymbolUpper,
                status: { not: CryptoWalletStatus.FAILED },
            },
            select: {
                network: true,
            },
        });

        const defaultNetworkNormalized = this.tradeHelpers.normalizeNetworkInput(
            walletResponse.default_network
        );

        this.logWalletFlow("ensureWalletPaymentAddresses:existing_addresses", {
            existingCount: existingAddresses.length,
            defaultNetworkNormalized,
        });

        const existingNetworkSet = this.buildExistingNetworkSet(
            existingAddresses,
            defaultNetworkNormalized,
            depositEnabledNetworkMap
        );

        return { existingNetworkSet, defaultNetworkNormalized };
    }

    /**
     * Retrieves full existing wallet addresses for an asset
     */
    private async getExistingWalletAddresses(
        userId: number,
        assetSymbolUpper: string
    ): Promise<CryptoWalletAddress[]> {
        this.logWalletFlow(
            "ensureWalletPaymentAddresses:all_networks_exist",
            { assetSymbol: assetSymbolUpper }
        );

        return await this.prisma.cryptoWalletAddress.findMany({
            where: {
                userId,
                assetSymbol: assetSymbolUpper,
            },
        });
    }

    /**
     * Deletes FAILED records for networks about to be re-created
     */
    private async deleteFailedRecordsForNetworks(
        userId: number,
        assetSymbolUpper: string,
        networksToCreate: NetworkTypes[]
    ): Promise<void> {
        if (!networksToCreate.length) return;

        await this.prisma.cryptoWalletAddress.deleteMany({
            where: {
                userId,
                assetSymbol: assetSymbolUpper,
                status: CryptoWalletStatus.FAILED,
                network: { in: networksToCreate },
            },
        });
    }

    /**
     * Creates payment addresses via Quidax and persists them
     */
    private async createAndPersistAddresses(options: {
        networksToCreate: NetworkTypes[];
        depositEnabledNetworkMap: Map<NetworkTypes, string>;
        cryptoSubAccountId: string;
        currency: string;
        userId: number;
        assetSymbolUpper: string;
        backfilledProviderAddresses: CryptoWalletAddress[];
    }): Promise<CryptoWalletAddress[]> {
        const creationResults = await Promise.allSettled(
            options.networksToCreate.map((network) =>
                this.createPaymentAddressForNetwork({
                    network,
                    depositEnabledNetworkMap: options.depositEnabledNetworkMap,
                    cryptoSubAccountId: options.cryptoSubAccountId,
                    currency: options.currency,
                    assetSymbolUpper: options.assetSymbolUpper,
                })
            )
        );

        const successfulCreations = this.filterSuccessfulCreations(creationResults);

        this.logWalletFlow("ensureWalletPaymentAddresses:creation_results", {
            successfulCount: successfulCreations.length,
            rejectedCount: creationResults.length - successfulCreations.length,
        });

        if (!successfulCreations.length) {
            throw new GeneralTransactionException(
                "Failed to create wallet addresses",
                HttpStatus.SERVICE_UNAVAILABLE
            );
        }

        const createdAddresses = await this.persistCreatedAddresses({
            successfulCreations,
            backfilledProviderAddresses: options.backfilledProviderAddresses,
            userId: options.userId,
            assetSymbolUpper: options.assetSymbolUpper,
        });

        this.logRejectedCreations(creationResults);

        return createdAddresses;
    }

    /**
     * Creates a single payment address for a network
     */
    private async createPaymentAddressForNetwork(options: {
        network: NetworkTypes;
        depositEnabledNetworkMap: Map<NetworkTypes, string>;
        cryptoSubAccountId: string;
        currency: string;
        assetSymbolUpper: string;
    }): Promise<{
        walletAddressId: string;
        network: NetworkTypes;
        address: string;
        destination_tag: string | null;
    }> {
        const providerNetwork = options.depositEnabledNetworkMap.get(options.network);

        if (!providerNetwork) {
            this.logWalletFlow(
                "ensureWalletPaymentAddresses:missing_provider_network",
                { network: options.network }
            );
            throw new GeneralTransactionException(
                `Unable to resolve provider network for ${options.network}`,
                HttpStatus.SERVICE_UNAVAILABLE
            );
        }

        this.logWalletFlow(
            "ensureWalletPaymentAddresses:creating_address",
            {
                network: options.network,
                providerNetwork,
                currency: options.currency,
                cryptoSubAccountId: options.cryptoSubAccountId,
            }
        );

        const response = await this.quidaxService.createPaymentAddress({
            user_id: options.cryptoSubAccountId,
            currency: options.currency,
            network: providerNetwork,
        });

        const responseNetworkValue = response.data.network || options.network;
        const normalizedNetwork =
            this.tradeHelpers.normalizeNetworkInput(responseNetworkValue);

        if (!normalizedNetwork) {
            this.logWalletFlow(
                "ensureWalletPaymentAddresses:unsupported_network_returned",
                {
                    responseNetworkValue,
                    providerNetwork,
                    assetSymbol: options.assetSymbolUpper,
                }
            );
            throw new GeneralTransactionException(
                `Unsupported network ${responseNetworkValue} returned while creating address for ${options.assetSymbolUpper}`,
                HttpStatus.SERVICE_UNAVAILABLE
            );
        }

        this.logWalletFlow(
            "ensureWalletPaymentAddresses:created_address",
            {
                walletAddressId: response.data.id,
                normalizedNetwork,
                address: response.data.address,
                destination_tag: response.data.destination_tag,
            }
        );

        return {
            walletAddressId: response.data.id,
            network: normalizedNetwork,
            address: response.data.address,
            destination_tag: response.data.destination_tag,
        };
    }

    /**
     * Filters successful creations from PromiseSettledResult array
     */
    private filterSuccessfulCreations(
        creationResults: PromiseSettledResult<{
            walletAddressId: string;
            network: NetworkTypes;
            address: string;
            destination_tag: string | null;
        }>[]
    ): PromiseFulfilledResult<{
        walletAddressId: string;
        network: NetworkTypes;
        address: string;
        destination_tag: string | null;
    }>[] {
        return creationResults.filter(
            (result): result is PromiseFulfilledResult<{
                walletAddressId: string;
                network: NetworkTypes;
                address: string;
                destination_tag: string | null;
            }> => result.status === "fulfilled"
        );
    }

    private async fetchProviderAddressMap(
        cryptoSubAccountId: string,
        currency: string,
    ): Promise<Map<NetworkTypes, IPaymentAddress>> {
        const providerAddressMap = new Map<NetworkTypes, IPaymentAddress>();

        try {
            const providerAddressResponse =
                await this.quidaxService.getPaymentAddressList({
                    user_id: cryptoSubAccountId,
                    currency,
                });

            const providerAddresses = providerAddressResponse.data ?? [];

            for (const providerAddress of providerAddresses) {
                const normalizedNetwork = this.tradeHelpers.normalizeNetworkInput(
                    providerAddress.network
                );

                if (normalizedNetwork) {
                    providerAddressMap.set(normalizedNetwork, providerAddress);
                }
            }

            this.logWalletFlow(
                "ensureWalletPaymentAddresses:provider_addresses_loaded",
                {
                    providerAddressCount: providerAddresses.length,
                    mappedCount: providerAddressMap.size,
                }
            );
        } catch (error) {
            this.logWalletFlow(
                "ensureWalletPaymentAddresses:provider_address_fetch_failed",
                { error: error?.message }
            );
        }

        return providerAddressMap;
    }

    private buildExistingNetworkSet(
        existingAddresses: { network: NetworkTypes | null }[],
        defaultNetworkNormalized: NetworkTypes | null,
        depositEnabledNetworkMap: Map<NetworkTypes, string>,
    ): Set<NetworkTypes> {
        const existingNetworkSet = new Set<NetworkTypes>();

        for (const existing of existingAddresses) {
            if (existing.network) {
                existingNetworkSet.add(existing.network);
                continue;
            }

            if (
                defaultNetworkNormalized &&
                depositEnabledNetworkMap.has(defaultNetworkNormalized)
            ) {
                existingNetworkSet.add(defaultNetworkNormalized);
            }
        }

        return existingNetworkSet;
    }


    private async backfillFromProviderAddresses(options: {
        providerAddressMap: Map<NetworkTypes, IPaymentAddress>;
        targetNetworks: NetworkTypes[];
        existingNetworkSet: Set<NetworkTypes>;
        userId: number;
        assetSymbolUpper: string;
    }): Promise<CryptoWalletAddress[]> {
        const { providerAddressMap, targetNetworks, existingNetworkSet, userId, assetSymbolUpper } = options;
        const backfilledAddresses: CryptoWalletAddress[] = [];

        for (const [network, providerAddress] of providerAddressMap.entries()) {
            if (!targetNetworks.includes(network) || existingNetworkSet.has(network)) continue;

            // Guard: never persist a record with null network or null address
            if (!this.validateBackfillData(providerAddress, network, userId, assetSymbolUpper)) continue;

            const record = await this.persistProviderAddress(userId, assetSymbolUpper, network, providerAddress);

            if (record) {
                backfilledAddresses.push(record);
                existingNetworkSet.add(network);
            }

        }

        if (backfilledAddresses.length) {
            this.logWalletFlow(
                "ensureWalletPaymentAddresses:provider_backfill_success",
                { backfilledCount: backfilledAddresses.length }
            );
        }

        return backfilledAddresses;
    }
    private validateBackfillData(
        providerAddress: IPaymentAddress,
        network: NetworkTypes,
        userId: number,
        assetSymbolUpper: string
    ): boolean {
        if (!providerAddress.address || !network) {
            this.logger.warn(
                `[ProviderGuard] Skipping persist incomplete data from Quidax, User: ${userId}, Asset: ${assetSymbolUpper}, HasAddress: ${!!providerAddress.address}, HasNetwork: ${!!network}`
            );
            return false;
        }
        return true;
    }

    private async persistProviderAddress(
        userId: number,
        assetSymbol: string,
        network: NetworkTypes,
        providerAddress: IPaymentAddress
    ): Promise<CryptoWalletAddress | null> {
        try {
            const hasAddress = Boolean(providerAddress.address);
            const status = hasAddress ? CryptoWalletStatus.ACTIVE : CryptoWalletStatus.PENDING;
            const lastSyncedAt = hasAddress ? new Date() : undefined;

            return await this.prisma.cryptoWalletAddress.upsert({
                where: { walletAddressId: providerAddress.id },
                update: {
                    address: providerAddress.address,
                    destination_tag: providerAddress.destination_tag,
                    status,
                    lastSyncedAt,
                    network,
                },
                create: {
                    userId,
                    assetSymbol,
                    network,
                    address: providerAddress.address,
                    destination_tag: providerAddress.destination_tag,
                    status,
                    lastSyncedAt,
                },
            });
        } catch (error) {
            this.logWalletFlow("ensureWalletPaymentAddresses:provider_backfill_failed", {
                network,
                error: error?.message,
                userId
            });
            return null;
        }
    }

    /**
     * Fallback: if Quidax's wallet object has a deposit_address but the
     * payment-address APIs returned null, update any PENDING records on
     * the wallet's default network with the known address.
     */
    private async applyWalletAddressFallback(
        userId: number,
        assetSymbolUpper: string,
        walletResponse: GetUserWalletResponse,
    ): Promise<void> {
        if (!walletResponse.deposit_address) return;

        const defaultNetwork = this.tradeHelpers.normalizeNetworkInput(
            walletResponse.default_network,
        );
        if (!defaultNetwork) return;

        const result = await this.prisma.cryptoWalletAddress.updateMany({
            where: {
                userId,
                assetSymbol: assetSymbolUpper,
                network: defaultNetwork,
                status: CryptoWalletStatus.PENDING,
                address: null,
            },
            data: {
                address: walletResponse.deposit_address,
                destination_tag: walletResponse.destination_tag,
                status: CryptoWalletStatus.ACTIVE,
                lastSyncedAt: new Date(),
            },
        });

        if (result.count > 0) {
            this.logWalletFlow("applyWalletAddressFallback:updated", {
                network: defaultNetwork,
                updatedCount: result.count,
                depositAddress: walletResponse.deposit_address,
            });
        }
    }

    private async persistCreatedAddresses(options: {
        successfulCreations: PromiseFulfilledResult<{
            walletAddressId: string;
            network: NetworkTypes;
            address: string;
            destination_tag: string | null;
        }>[];
        backfilledProviderAddresses: CryptoWalletAddress[];
        userId: number;
        assetSymbolUpper: string;
    }): Promise<CryptoWalletAddress[]> {
        const { successfulCreations, backfilledProviderAddresses, userId, assetSymbolUpper } = options;
        const createdAddresses: CryptoWalletAddress[] = [
            ...backfilledProviderAddresses,
        ];

        this.logWalletFlow(
            "ensureWalletPaymentAddresses:persisting_addresses",
            { createCount: successfulCreations.length }
        );

        try {
            await this.prisma.$transaction(
                async (tx) => {
                    for (const creation of successfulCreations) {
                        const hasAddress = Boolean(creation.value.address);

                        const record = await tx.cryptoWalletAddress.upsert({
                            where: {
                                userId_assetSymbol_network: {
                                    userId,
                                    assetSymbol: assetSymbolUpper,
                                    network: creation.value.network,
                                },
                            },
                            update: {
                                walletAddressId: creation.value.walletAddressId,
                                address: creation.value.address,
                                destination_tag: creation.value.destination_tag,
                                status: hasAddress
                                    ? CryptoWalletStatus.ACTIVE
                                    : CryptoWalletStatus.PENDING,
                                lastSyncedAt: hasAddress ? new Date() : undefined,
                            },
                            create: {
                                assetSymbol: assetSymbolUpper,
                                walletAddressId: creation.value.walletAddressId,
                                userId,
                                network: creation.value.network,
                                address: creation.value.address,
                                destination_tag: creation.value.destination_tag,
                                status: hasAddress
                                    ? CryptoWalletStatus.ACTIVE
                                    : CryptoWalletStatus.PENDING,
                                lastSyncedAt: hasAddress ? new Date() : undefined,
                            },
                        });

                        createdAddresses.push(record);
                    }
                },
                { timeout: DEFAULT_TRANSACTION_TIMEOUT_MS }
            );
        } catch (error) {
            this.logWalletFlow("ensureWalletPaymentAddresses:persist_failed", {
                error: error?.message,
            });
            throw error;
        }

        return createdAddresses;
    }

    private logRejectedCreations(creationResults: PromiseSettledResult<{
        walletAddressId: string;
        network: NetworkTypes;
        address: string;
        destination_tag: string | null;
    }>[]) {
        const rejectedErrors = creationResults.filter(
            (result): result is PromiseRejectedResult =>
                result.status === "rejected"
        );

        if (rejectedErrors.length) {
            this.logWalletFlow(
                "ensureWalletPaymentAddresses:rejected_creations",
                { count: rejectedErrors.length }
            );
            rejectedErrors.forEach((err) =>
                this.logger.error(
                    `[WalletFlow] ensureWalletPaymentAddresses:rejected_creation reason=${err.reason}`
                )
            );
        }
    }

    private validateRequestedNetworks(
        requestedNetworks: string[],
        depositEnabledNetworkMap: Map<NetworkTypes, string>,
        currency: string,
    ): NetworkTypes[] {
        const normalizedRequests = new Set<NetworkTypes>();

        for (const requested of requestedNetworks) {
            const normalized = this.tradeHelpers.normalizeNetworkInput(requested);

            if (!normalized || !depositEnabledNetworkMap.has(normalized)) {
                this.logWalletFlow(
                    "ensureWalletPaymentAddresses:requested_network_unavailable",
                    { requested }
                );
                throw new OutOfRangeException(
                    `Network ${requested} is not available for ${currency.toUpperCase()}`,
                    HttpStatus.BAD_REQUEST
                );
            }

            normalizedRequests.add(normalized);
        }

        return Array.from(normalizedRequests);
    }

    /**
     * Gets a specific wallet address for a user
     * 
     * @param userId - The user's database ID
     * @param dto - Query parameters (asset, network)
     */
    async getWalletAddress(userId: number, dto: GetWalletDto) {
        const wallet = await this.prisma.cryptoWalletAddress.findUnique({
            where: {
                userId_assetSymbol_network: {
                    userId,
                    assetSymbol: dto.asset.toUpperCase(),
                    network: dto.network,
                },
            },
        });

        return buildResponse({
            message: "wallet info retrieved",
            data: wallet,
        });
    }

    /**
     * Gets all wallet addresses for a user and specific asset.
     * Automatically triggers address creation for any missing or failed networks.
     * 
     * @param userId - The user's database ID
     * @param dto - Query parameters (asset)
     */
    async getWalletAddresses(userId: number, dto: GetWalletAddressesDto) {
        const assetSymbol = dto.asset.toUpperCase();

        // Ensure wallet addresses exist (handles FAILED cleanup + creation)
        try {
            const user = await this.prisma.user.findUnique({
                where: { id: userId },
                select: { cryptoSubAccountId: true },
            });

            if (user?.cryptoSubAccountId) {
                await this.ensureWalletPaymentAddresses({
                    userId,
                    cryptoSubAccountId: user.cryptoSubAccountId,
                    assetSymbol,
                });
            }
        } catch (error) {
            this.logger.warn(
                `getWalletAddresses: failed to ensure addresses for userId=${userId}, asset=${assetSymbol}: ${error.message}`
            );
        }

        const wallets = await this.prisma.cryptoWalletAddress.findMany({
            where: {
                userId,
                assetSymbol,
                status: CryptoWalletStatus.ACTIVE,
                address: { not: null },
            },
            orderBy: { createdAt: "desc" },
        });

        return buildResponse({
            message: "wallet addresses retrieved",
            data: wallets,
        });
    }

    /**
     * Verifies a wallet address via Quidax
     * 
     * @param dto - The address verification parameters
     */
    async verifyWalletAddress(dto: VerifyWalletAddressDto) {
        const info = await this.quidaxService.verifyAddress({
            address: dto.address,
            currency: dto.currency,
            network: dto.network,
        });

        return buildResponse({
            message: "wallet address info retrieved",
            data: info.data,
        });
    }

    /**
     * Initiates wallet address creation for a user
     * 
     * @param userId - The user's database ID
     * @param dto - The wallet creation parameters
     */
    async initiateWalletAddressCreation(
        userId: number,
        dto: InitiateWalletCreationDto
    ) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
        });

        if (!user?.cryptoSubAccountId) {
            throw new UserNotFoundException(
                "User or sub-account not found",
                HttpStatus.NOT_FOUND
            );
        }

        const createdAddresses = await this.ensureWalletPaymentAddresses({
            userId: user.id,
            cryptoSubAccountId: user.cryptoSubAccountId,
            assetSymbol: dto.asset.toUpperCase(),
            requestedNetworks: dto.network ? [dto.network] : undefined,
        });

        const hasCreatedAddresses = createdAddresses.length > 0;

        return buildResponse({
            message: hasCreatedAddresses
                ? "wallet address generation initiated"
                : "wallet address already exists",
            data: {
                walletGenerationStatus: hasCreatedAddresses
                    ? "initiated"
                    : "already_created",
                addresses: hasCreatedAddresses ? createdAddresses : undefined,
            },
        });
    }
}
