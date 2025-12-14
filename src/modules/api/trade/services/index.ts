import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { buildResponse } from "@/utils/api-response-util";
import { PrismaService } from "@/modules/core/prisma/services";

import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import { CoinGeckoService } from "@/modules/factory/trading/providers/coingecko/services";
import { LiveCoinWatchService } from "@/modules/factory/trading/providers/livecoinwatch/services";
import { GetUserWalletResponse, IPaymentAddress } from "@/libs/quidax";
import {
    AccountCreationException,
    AssetNotFoundException,
    GeneralTransactionException,
    IncompleteAccountSetupException,
    OutOfRangeException,
    TransactionCompletedException,
    TransactionNotFoundException,
    UnknownFeeStructureException,
    WalletAddressNotFoundException,
} from "../errors";
import {
    BuyQuoteResponse,
    DepositTransaction,
    getStreamlinedStatus,
    IWalletAddressCreatedSuccess,
    IWalletUpdated,
    OrderType,
    SellQuoteResponse,
    SupportedAssets,
    SwapTransactionHandlerOptions,
    TradingPair,
    WithdrawerTransactionHandlerOptions,
} from "../interfaces/trade";
import {
    CryptoWalletAddress,
    CryptoWalletStatus,
    NetworkTypes,
    NotificationBeneficiary,
    NotificationStatus,
    NotificationType,
    OrderCategory,
    OrderSide,
    OrderStatus,
    PaymentMethod,
    TransactionFeeCategory,
    TransactionStatus,
    TransactionType,
    User,
    UserNotificationTarget,
} from "@prisma/client";
import {
    CancelWithdrawerRequestDto,
    ConfirmInstantSwapQuoteDto,
    GetCryptoWithdrawerFeeDto,
    GetWalletDto,
    GetWalletAddressesDto,
    InitiateBuyOrderDto,
    InitiateSellOrderDto,
    InitiateWalletCreationDto,
    PlaceInstantSwapRequestDto,
    PurchaseLimitBuyDto,
    RefreshInstantSwapRequestDto,
    SellCryptoOrderDto,
    SupportedPaymentMethodDto,
    VerifyWalletAddressDto,
    WithdrawerRequestDto,
} from "../dtos";
import { UserNotFoundException } from "../../user";
import { CryptoAccountQueueProducer } from "../queues/producers/producer.service";
import { GetPaymentAddressByIdOptions } from "@/libs/quidax";
import { generateId } from "@/utils";
import { BankInjectionToken } from "@/modules/factory/bank/types";
import { FincraBank } from "@/modules/factory/bank/providers/fincra.provider";
import { FincraInitiationResponseResultType } from "@/modules/factory/bank/types/fincra";
import { COMPANY_NAME } from "@/config";
import {
    CryptoRateNotFoundException,
    CryptoTransactionFeeNotFoundException,
} from "../../settings/errors";
import { BankDetailNotFoundException } from "../../banks/errors";
import { NotificationEvent } from "../../notification/events/notification.event";
import { NotificationMessageService } from "@/modules/core/messages/services/notification.service";
import { WsGateway } from "../gateway/v1";

const NETWORK_ALIAS_MAP: Record<string, NetworkTypes> = {
    trc20: NetworkTypes.trc20,
    tron: NetworkTypes.trc20, // Map tron to trc20 for Quidax API compatibility
    erc20: NetworkTypes.erc20,
    ethereum: NetworkTypes.erc20,
    eth: NetworkTypes.erc20,
    bep20: NetworkTypes.bep20,
    bsc: NetworkTypes.bep20,
    bnb: NetworkTypes.bep20,
    btc: NetworkTypes.btc,
    bitcoin: NetworkTypes.btc,
    ltc: NetworkTypes.ltc,
    litecoin: NetworkTypes.ltc,
    dash: NetworkTypes.dash,
    doge: NetworkTypes.doge,
    dogecoin: NetworkTypes.doge,
    bch: NetworkTypes.bch,
    "bitcoin cash": NetworkTypes.bch,
    ripple: NetworkTypes.ripple,
    xrp: NetworkTypes.ripple,
    stellar: NetworkTypes.stellar,
    xlm: NetworkTypes.stellar,
    cardano: NetworkTypes.cardano,
    ada: NetworkTypes.cardano,
    solana: NetworkTypes.solana,
    sol: NetworkTypes.solana,
    polygon: NetworkTypes.polygon,
    matic: NetworkTypes.polygon,
    ton: NetworkTypes.ton,
    celo: NetworkTypes.celo,
    optimism: NetworkTypes.optimism,
    arbitrum: NetworkTypes.arbitrum,
    base: NetworkTypes.base,
};

const NETWORK_SEGMENT_SPLITTER = /[\s/_-]+/;

// Supported cryptocurrencies with full Quidax wallet support
const SUPPORTED_ASSETS = new Set([
    "BTC",   // Bitcoin
    "ETH",   // Ethereum
    "USDT",  // Tether
    "USDC",  // USD Coin
    "BNB",   // Binance Coin
    "SOL",   // Solana
    "XRP",   // Ripple
    "ADA",   // Cardano
    "DOGE",  // Dogecoin
    "LTC",   // Litecoin
    "TRX",   // Tron
    "SHIB",  // Shiba Inu
]);

@Injectable()
export class TradingService {
    private readonly logger = new Logger("TradeService");
    private readonly supportedNetworkSet = new Set<string>(
        Object.values(NetworkTypes)
    );

    private logWalletFlow(step: string, payload: Record<string, unknown> = {}) {
        const safePayload = JSON.stringify(payload, (_, value) =>
            typeof value === "bigint" ? value.toString() : value
        );

        console.log(`[WalletFlow] ${step}`, payload);
        this.logger.log(`${step} | ${safePayload}`, "WalletFlow");
    }

    constructor(
        private readonly prisma: PrismaService,
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService,
        private readonly cryptoAccountQueueProducer: CryptoAccountQueueProducer,
        @Inject(BankInjectionToken.FINCRA)
        private readonly fincraService: FincraBank,
        private readonly notificationEvent: NotificationEvent,
        private readonly notificationMessage: NotificationMessageService,
        private readonly wsGateway: WsGateway,
        @Inject(TradingInjectionToken.COINGECKO)
        private readonly coinGeckoService: CoinGeckoService,
        @Inject(TradingInjectionToken.LIVECOINWATCH)
        private readonly liveCoinWatchService: LiveCoinWatchService
    ) {}

    getSupportedAssets() {
        const assets = Object.values(SupportedAssets);

        return buildResponse({
            message: "Supported assets retrieved",
            data: assets,
        });
    }

    async getSupportedPaymentMethod(query: SupportedPaymentMethodDto) {
        const result = await this.quidaxService.getPaymentMethods(query);

        return buildResponse({
            message: "Supported payment methods retrieved",
            data: result.data,
        });
    }

    async getPurchaseLimitForBuy(query: PurchaseLimitBuyDto) {
        const result = await this.quidaxService.getPurchaseLimitForBuy(query);

        return buildResponse({
            message: "Purchase limit retrieved",
            data: result.data,
        });
    }

    getSupportedNetworks() {
        const networks = Object.values(NetworkTypes);

        return buildResponse({
            message: "Supported networks retrieved",
            data: networks,
        });
    }

    getSupportedTradingPairs() {
        const tradingPair = Object.values(TradingPair);

        return buildResponse({
            message: "Supported Trading Pairs retrieved",
            data: tradingPair,
        });
    }

    private normalizeNetworkInput(
        network?: string | null
    ): NetworkTypes | null {
        if (!network) {
            return null;
        }

        const trimmed = network.trim().toLowerCase();

        if (!trimmed) {
            return null;
        }

        const directMatch =
            NETWORK_ALIAS_MAP[trimmed] ||
            (this.supportedNetworkSet.has(trimmed)
                ? (trimmed as NetworkTypes)
                : null);

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
                (this.supportedNetworkSet.has(segment)
                    ? (segment as NetworkTypes)
                    : null);

            if (alias) {
                return alias;
            }
        }

        return null;
    }

    private extractDepositEnabledNetworkMap(
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
                    {
                        candidate,
                    }
                );
                return;
            }

            const normalized = this.normalizeNetworkInput(candidate);

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

        if (!SUPPORTED_ASSETS.has(assetSymbolUpper)) {
            this.logWalletFlow("ensureWalletPaymentAddresses:skip_asset", {
                assetSymbol: assetSymbolUpper,
            });
            return [];
        }

        const walletResponse =
            options.walletData ??
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
            return [];
        }

        const depositEnabledNetworkMap =
            this.extractDepositEnabledNetworkMap(walletResponse);

        if (!depositEnabledNetworkMap.size) {
            this.logWalletFlow(
                "ensureWalletPaymentAddresses:no_deposit_enabled_network",
                { currency, cryptoSubAccountId }
            );
            return [];
        }

        let targetNetworks = Array.from(depositEnabledNetworkMap.keys());

        let providerAddresses: IPaymentAddress[] = [];
        const providerAddressMap = new Map<NetworkTypes, IPaymentAddress>();

        try {
            const providerAddressResponse =
                await this.quidaxService.getPaymentAddressList({
                    user_id: cryptoSubAccountId,
                    currency,
                });

            providerAddresses = providerAddressResponse.data ?? [];

            for (const providerAddress of providerAddresses) {
                const normalizedNetwork = this.normalizeNetworkInput(
                    providerAddress.network
                );

                if (!normalizedNetwork) {
                    continue;
                }

                providerAddressMap.set(normalizedNetwork, providerAddress);
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
                {
                    error: error?.message,
                }
            );
        }
        this.logWalletFlow("ensureWalletPaymentAddresses:initial_targets", {
            targetNetworks,
        });

        if (options.requestedNetworks?.length) {
            const normalizedRequests = new Set<NetworkTypes>();

            for (const requested of options.requestedNetworks) {
                const normalized = this.normalizeNetworkInput(requested);

                if (!normalized || !depositEnabledNetworkMap.has(normalized)) {
                    this.logWalletFlow(
                        "ensureWalletPaymentAddresses:requested_network_unavailable",
                        { requested }
                    );
                    throw new OutOfRangeException(
                        `Network ${requested} is not available for ${walletResponse.currency.toUpperCase()}`,
                        HttpStatus.BAD_REQUEST
                    );
                }

                normalizedRequests.add(normalized);
            }

            targetNetworks = Array.from(normalizedRequests);
            this.logWalletFlow(
                "ensureWalletPaymentAddresses:filtered_requested_networks",
                { targetNetworks }
            );
        }

        if (!targetNetworks.length) {
            this.logWalletFlow(
                "ensureWalletPaymentAddresses:no_target_networks_after_filter",
                { currency, cryptoSubAccountId }
            );
            return [];
        }

        const existingAddresses =
            await this.prisma.cryptoWalletAddress.findMany({
                where: {
                    userId,
                    assetSymbol: assetSymbolUpper,
                },
                select: {
                    network: true,
                },
            });

        const existingNetworkSet = new Set<NetworkTypes>();

        const defaultNetworkNormalized = this.normalizeNetworkInput(
            walletResponse.default_network
        );

        this.logWalletFlow("ensureWalletPaymentAddresses:existing_addresses", {
            existingCount: existingAddresses.length,
            defaultNetworkNormalized,
        });

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

        const backfilledProviderAddresses: CryptoWalletAddress[] = [];

        for (const [network, providerAddress] of providerAddressMap.entries()) {
            if (!targetNetworks.includes(network)) {
                continue;
            }

            if (existingNetworkSet.has(network)) {
                continue;
            }

            try {
                const hasAddress = Boolean(providerAddress.address);

                const record = await this.prisma.cryptoWalletAddress.upsert({
                    where: { walletAddressId: providerAddress.id },
                    update: {
                        address: providerAddress.address,
                        destination_tag: providerAddress.destination_tag,
                        status: hasAddress
                            ? CryptoWalletStatus.ACTIVE
                            : CryptoWalletStatus.PENDING,
                        lastSyncedAt: hasAddress ? new Date() : undefined,
                        network,
                    },
                    create: {
                        assetSymbol: assetSymbolUpper,
                        walletAddressId: providerAddress.id,
                        userId,
                        network,
                        address: providerAddress.address,
                        destination_tag: providerAddress.destination_tag,
                        status: hasAddress
                            ? CryptoWalletStatus.ACTIVE
                            : CryptoWalletStatus.PENDING,
                        lastSyncedAt: hasAddress ? new Date() : undefined,
                    },
                });

                backfilledProviderAddresses.push(record);
                existingNetworkSet.add(network);
            } catch (error) {
                this.logWalletFlow(
                    "ensureWalletPaymentAddresses:provider_backfill_failed",
                    {
                        network,
                        error: error?.message,
                    }
                );
            }
        }

        if (backfilledProviderAddresses.length) {
            this.logWalletFlow(
                "ensureWalletPaymentAddresses:provider_backfill_success",
                {
                    backfilledCount: backfilledProviderAddresses.length,
                }
            );
        }

        targetNetworks = targetNetworks.filter(
            (network) => !existingNetworkSet.has(network)
        );

        const networksToCreate = targetNetworks.filter(
            (network) => !existingNetworkSet.has(network)
        );

        this.logWalletFlow("ensureWalletPaymentAddresses:networks_to_create", {
            networksToCreate,
        });

        if (!networksToCreate.length) {
            this.logWalletFlow(
                "ensureWalletPaymentAddresses:all_networks_exist",
                { assetSymbol: assetSymbolUpper }
            );
            return [];
        }

        const creationResults = await Promise.allSettled(
            networksToCreate.map(async (network) => {
                const providerNetwork = depositEnabledNetworkMap.get(network);

                if (!providerNetwork) {
                    this.logWalletFlow(
                        "ensureWalletPaymentAddresses:missing_provider_network",
                        { network }
                    );
                    throw new GeneralTransactionException(
                        `Unable to resolve provider network for ${network}`,
                        HttpStatus.SERVICE_UNAVAILABLE
                    );
                }

                this.logWalletFlow(
                    "ensureWalletPaymentAddresses:creating_address",
                    {
                        network,
                        providerNetwork,
                        currency,
                        cryptoSubAccountId,
                    }
                );
                const response = await this.quidaxService.createPaymentAddress({
                    user_id: cryptoSubAccountId,
                    currency,
                    network: providerNetwork,
                });

                const responseNetworkValue = response.data.network || network;
                const normalizedNetwork =
                    this.normalizeNetworkInput(responseNetworkValue);

                if (!normalizedNetwork) {
                    this.logWalletFlow(
                        "ensureWalletPaymentAddresses:unsupported_network_returned",
                        {
                            responseNetworkValue,
                            providerNetwork,
                            assetSymbol: assetSymbolUpper,
                        }
                    );
                    throw new GeneralTransactionException(
                        `Unsupported network ${responseNetworkValue} returned while creating address for ${assetSymbolUpper}`,
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
            })
        );

        const successfulCreations = creationResults.filter(
            (
                result
            ): result is PromiseFulfilledResult<{
                walletAddressId: string;
                network: NetworkTypes;
                address: string;
                destination_tag: string | null;
            }> => result.status === "fulfilled"
        );

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

        const createdAddresses: CryptoWalletAddress[] = [
            ...backfilledProviderAddresses,
        ];

        this.logWalletFlow(
            "ensureWalletPaymentAddresses:persisting_addresses",
            {
                createCount: successfulCreations.length,
            }
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
                { timeout: 20000 }
            );
        } catch (error) {
            this.logWalletFlow("ensureWalletPaymentAddresses:persist_failed", {
                error: error?.message,
            });
            throw error;
        }

        const rejectedErrors = creationResults.filter(
            (result): result is PromiseRejectedResult =>
                result.status === "rejected"
        );

        if (rejectedErrors.length) {
            this.logWalletFlow(
                "ensureWalletPaymentAddresses:rejected_creations",
                { count: rejectedErrors.length }
            );
            rejectedErrors.forEach((err, index) =>
                console.error(
                    `[WalletFlow] ensureWalletPaymentAddresses:rejected_detail index=${index}`,
                    err.reason
                )
            );
        }

        this.logWalletFlow("ensureWalletPaymentAddresses:complete", {
            createdAddresses: createdAddresses.map((address) => ({
                id: address.id,
                network: address.network,
            })),
        });
        return createdAddresses;
    }

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

    async getWalletAddresses(userId: number, dto: GetWalletAddressesDto) {
        const wallets = await this.prisma.cryptoWalletAddress.findMany({
            where: {
                userId,
                assetSymbol: dto.asset.toUpperCase(),
            },
            orderBy: { createdAt: "desc" },
        });

        return buildResponse({
            message: "wallet addresses retrieved",
            data: wallets,
        });
    }

    async verifyWalletAddress(dto: VerifyWalletAddressDto) {
        const info = await this.quidaxService.verifyAddress({
            address: dto.address,
            currency: dto.currency,
        });

        return buildResponse({
            message: "wallet address info retrieved",
            data: info.data,
        });
    }

    async getCryptoWithdrawerFee(dto: GetCryptoWithdrawerFeeDto) {
        const currency = dto.currency.toUpperCase();

        // Fetch both provider fee and admin transaction fee
        const [providerFeeInfo, adminFee] = await Promise.all([
            this.quidaxService.getWithdrawerFees({
                currency: dto.currency,
                ...(dto.network && { network: dto.network }),
            }),
            this.prisma.transactionFee.findUnique({
                where: {
                    category_currency: {
                        category: TransactionFeeCategory.SELL,
                        currency,
                    },
                },
            }),
        ]);

        console.log(`Admin fee for ${currency}:`, adminFee);

        // Calculate provider fee
        const providerFee = await this.getFee(dto.amount, providerFeeInfo.data);

        // Calculate admin fee (default to 0 if not configured)
        const adminFeeAmount = adminFee ? adminFee.fee : 0;

        // Calculate total fee (provider fee + admin fee)
        const totalFee = providerFee.fee + adminFeeAmount;

        return buildResponse({
            message: "withdrawer fee info retrieved",
            data: {
                networkFee: providerFee.fee,
                adminFee: adminFeeAmount,
                totalFee: totalFee,
                feeType: providerFee.type,
                currency: currency,
            },
        });
    }

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

    async buyCryptoQuoteRequest(user: User, dto: InitiateBuyOrderDto) {
        const responseData = await this.calculateBuyQuote(user, dto);

        return buildResponse({
            message: "Quotation for buy order retrieved successfully",
            data: responseData,
        });
    }

    async sellCryptoQuoteRequest(user: User, dto: InitiateSellOrderDto) {
        const responseData = await this.calculateSellQuote(user, dto);

        return buildResponse({
            message: "Quotation for sell order retrieved successfully",
            data: responseData,
        });
    }

    async buyCryptoOrder(user: User, dto: InitiateBuyOrderDto) {
        const responseData = await this.calculateBuyQuote(user, dto);

        const userData = {
            id: user.id,
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            phoneNumber: user.phone,
        };

        const amount = +responseData.totalToChargeViaPaymentGateway;
        Logger.log(`amount: ${typeof amount}`);
        const { data } = await this.fincraService.initializePayment(
            userData,
            amount
        );

        const result = data as unknown as FincraInitiationResponseResultType;

        const amtFiat = await this.getAmountInNaira(
            dto.asset,
            responseData.cryptoBuyAmount
        );

        const order = await this.prisma.$transaction(
            async (tx) => {
                const order = await tx.order.create({
                    data: {
                        orderCategory: OrderCategory.BUY,
                        transactionId: generateId({ type: "transaction" }),
                        amount: responseData.cryptoBuyAmount,
                        fee: responseData.transactionFeeInCrypto,
                        total: responseData.totalToChargeInCrypto,
                        status: OrderStatus.pending,
                        streamlinedStatus: getStreamlinedStatus(OrderStatus.pending),
                        paymentStatus: TransactionStatus.PENDING,
                        currency: dto.asset.toUpperCase(),
                        recipient: responseData.depositAddress,
                        destinationTag: responseData.destinationTag,
                        userId: user.id,
                        amountInFiat: amtFiat?.amount,
                        rateAtConversion: amtFiat?.rate,
                    },
                });
                await tx.payment.create({
                    data: {
                        reference: result.reference,
                        userId: user.id,
                        amount:
                            responseData.buyRate * responseData.cryptoBuyAmount,
                        chargeFee:
                            responseData.buyRate *
                            responseData.transactionFeeInCrypto,
                        totalAmount:
                            responseData.totalToChargeViaPaymentGateway,
                        type: TransactionType.P2P_PAYMENT,
                        status: TransactionStatus.PENDING,
                        paymentStatus: TransactionStatus.PENDING,
                        paymentMethod: PaymentMethod.FINCRA,
                        sessionId: generateId({ type: "sessionId" }),
                        transactionId: generateId({ type: "transaction" }),
                        title: `${COMPANY_NAME} p2p buy order payment`,
                        narration: `Buy order payment for order with id ${order.id}`,
                        orderId: order.id,
                        isDebit: false,
                        expectedCurrency: responseData.currency,
                    },
                });

                return order;
            },
            { maxWait: 5000, timeout: 40000 }
        );

        return buildResponse({
            message:
                "Order placed successfully, Please proceed to make payment",
            data: {
                order: order,
                paymentInfo: {
                    ...data,
                    authorization_url: data.link,
                },
            },
        });
    }

    async sellCryptoOrder(user: User, dto: SellCryptoOrderDto) {
        const responseData = await this.calculateSellQuote(user, dto, true);

        const sendAmountToSeller = +responseData.totalToReceiveInFiat;
        const totalCryptoToAdmin = +responseData.totalCryptoToAdmin;

        //step 1: send crypto to admin quidax account
        const reference = generateId({ type: "reference" });
        const adminAssetWallet = await this.quidaxService.getUserWallet({
            user_id: "me",
            currency: dto.asset.toLowerCase(),
        });

        if (!adminAssetWallet.data.deposit_address) {
            await this.quidaxService.createPaymentAddress({
                user_id: "me",
                currency: dto.asset.toLowerCase(),
            });

            throw new GeneralTransactionException(
                "Destination crypto address is being set, Please try again",
                HttpStatus.BAD_REQUEST
            );
        }

        const requestRes = await this.quidaxService.createWithdrawerRequest({
            amount: totalCryptoToAdmin.toString(),
            currency: dto.asset.toLowerCase(),
            narration: "flipxer sell order transaction",
            transaction_note: "flipxer sell order transaction",
            user_id: user.cryptoSubAccountId,
            fund_uid: adminAssetWallet.data.deposit_address, //receiving wallet address //main account on quidax
            fund_uid2: adminAssetWallet.data.destination_tag, // destination tag
            reference: reference,
        });

        const amtFiat = await this.getAmountInNaira(
            dto.asset,
            responseData.cryptoSellAmount,
            "sell"
        );

        const order = await this.prisma.order.create({
            data: {
                orderCategory: OrderCategory.SELL,
                status: OrderStatus.processing,
                streamlinedStatus: getStreamlinedStatus(OrderStatus.processing),
                orderReference: reference,
                transactionId: generateId({ type: "transaction" }),
                providerOrderId: requestRes.data.id,
                userId: user.id,
                currency: requestRes.data.currency.toUpperCase(),
                narration: requestRes.data.narration,
                transaction_note: requestRes.data.transaction_note,
                recipient: requestRes.data.recipient.details.address,
                amount: +responseData.cryptoSellAmount,
                fee: +responseData.transactionFeeInCrypto,
                total: +responseData.totalCostInCrypto,
                totalToReceiveInFiat: sendAmountToSeller,
                sourceType: requestRes.data.type,
                destinationBankName: dto.bankDetail.bankName,
                destinationBankAccountNumber: dto.bankDetail.accountNumber,
                destinationBankAccountName: dto.bankDetail.accountName,
                destinationBankCode: dto.bankDetail.bankCode,
                amountInFiat: amtFiat?.amount,
                rateAtConversion: amtFiat?.rate,
            },
        });

        //step 2: once step 1 is successfully completed (webhook listener), send fund to user bank account from paystack main account

        return buildResponse({
            message: "Order placed successfully, Payment is processing",
            data: order,
        });
    }

    async calculateBuyQuote(
        user: User,
        dto: InitiateBuyOrderDto
    ): Promise<BuyQuoteResponse> {
        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "Please complete your account setup or contact admin for support",
                HttpStatus.BAD_REQUEST
            );
        }

        const assetExist = await this.prisma.assetWallet.findFirst({
            where: { userId: user.id, assetCurrency: dto.asset.toUpperCase() },
        });

        if (!assetExist) {
            throw new AssetNotFoundException(
                `Asset ${dto.asset} not found for the user`,
                HttpStatus.NOT_FOUND
            );
        }

        if (!assetExist.depositAddress || !assetExist.defaultNetwork) {
            throw new WalletAddressNotFoundException(
                `No wallet address found for asset ${dto.asset}`,
                HttpStatus.NOT_FOUND
            );
        }

        const currency = dto.asset.toUpperCase();
        // sell rate is used when user is buying.
        const [rate, adminFeeInCrypto] = await Promise.all([
            this.prisma.cryptoRate.findUnique({ where: { currency } }),
            this.prisma.transactionFee.findUnique({
                where: {
                    category_currency: {
                        category: TransactionFeeCategory.SELL,
                        currency,
                    },
                },
            }),
        ]);

        if (!rate) {
            throw new CryptoRateNotFoundException(
                `No rate found for asset ${dto.asset}`
            );
        }

        if (!adminFeeInCrypto) {
            throw new CryptoTransactionFeeNotFoundException(
                `No transaction fee record found for asset ${dto.asset}`
            );
        }

        const quidaxFeeRes = await this.quidaxService.getWithdrawerFees({
            currency: assetExist.assetCurrency.toLowerCase(),
            network: assetExist.defaultNetwork,
        });

        const quidaxFeeInCrypto = await this.getFee(
            dto.amount,
            quidaxFeeRes.data
        );

        const assetValueInNaira = dto.amount * rate.sellRate;
        const quidaxFeeInNaira = quidaxFeeInCrypto.fee * rate.sellRate;
        const adminFeeInNaira = adminFeeInCrypto.fee * rate.sellRate;

        const totalToChargeInCrypto =
            dto.amount + quidaxFeeInCrypto.fee + adminFeeInCrypto.fee;
        const totalToChargeViaPaymentGateway =
            assetValueInNaira + quidaxFeeInNaira + adminFeeInNaira;

        return {
            buyRate: rate.sellRate,
            cryptoBuyAmount: dto.amount,
            transactionFeeInCrypto:
                quidaxFeeInCrypto.fee + adminFeeInCrypto.fee,
            totalToChargeInCrypto,
            totalToChargeViaPaymentGateway,
            currency: "NGN",
            paymentGateway: PaymentMethod.FINCRA,
            depositAddress: assetExist.depositAddress,
            destinationTag: assetExist.destinationTag,
        };
    }

    async calculateSellQuote(
        user: User,
        dto: InitiateSellOrderDto,
        internal = false
    ): Promise<SellQuoteResponse> {
        // 1. Ensure crypto account is set up
        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "Please complete your account setup or contact admin for support",
                HttpStatus.BAD_REQUEST
            );
        }

        const currency = dto.asset.toUpperCase();

        // 2. Fetch bank detail, asset wallet, rate, and admin fee concurrently
        const [bankDetail, assetWallet, rate, adminFee] = await Promise.all([
            this.prisma.bankDetail.findFirst({
                where: { userId: user.id },
                select: {
                    accountName: true,
                    accountNumber: true,
                    bankName: true,
                },
            }),
            this.prisma.assetWallet.findFirst({
                where: {
                    userId: user.id,
                    assetCurrency: currency,
                },
            }),
            this.prisma.cryptoRate.findUnique({
                where: { currency },
            }),
            this.prisma.transactionFee.findUnique({
                where: {
                    category_currency: {
                        category: TransactionFeeCategory.BUY,
                        currency,
                    },
                },
            }),
        ]);

        // 3. Validate fetched records
        if (!bankDetail) {
            throw new BankDetailNotFoundException(
                "No bank detail found. Please setup your bank detail",
                HttpStatus.NOT_FOUND
            );
        }

        if (!assetWallet) {
            throw new AssetNotFoundException(
                `Asset ${dto.asset} not found for the user`,
                HttpStatus.NOT_FOUND
            );
        }

        const { depositAddress, defaultNetwork, assetCurrency } = assetWallet;

        if (!depositAddress || !defaultNetwork) {
            throw new WalletAddressNotFoundException(
                `No wallet address found for asset ${dto.asset}`,
                HttpStatus.NOT_FOUND
            );
        }

        if (!rate) {
            throw new CryptoRateNotFoundException(
                `No rate found for asset ${dto.asset}`
            );
        }

        if (!adminFee) {
            throw new CryptoTransactionFeeNotFoundException(
                `No transaction fee record found for asset ${dto.asset}`
            );
        }

        // 4. Fetch Quidax withdrawal fee and compute in crypto
        const { data: quidaxFeeData } =
            await this.quidaxService.getWithdrawerFees({
                currency: assetCurrency.toLowerCase(),
                network: defaultNetwork,
            });

        const { fee: quidaxFeeCrypto } = await this.getFee(
            dto.amount,
            quidaxFeeData
        );

        // 5. Calculations
        const buyRate = rate.buyRate;
        const adminFeeCrypto = adminFee.fee;

        const assetValueInNaira = dto.amount * buyRate;
        const quidaxFeeInNaira = quidaxFeeCrypto * buyRate;
        const adminFeeInNaira = adminFeeCrypto * buyRate;

        const totalCostInCrypto = dto.amount + quidaxFeeCrypto + adminFeeCrypto;
        const totalCostInFiat =
            assetValueInNaira + quidaxFeeInNaira + adminFeeInNaira;
        const totalCryptoToAdmin = dto.amount + adminFeeCrypto;

        // 6. Build response
        return {
            sellRate: buyRate,
            cryptoSellAmount: dto.amount,
            transactionFeeInCrypto: quidaxFeeCrypto + adminFeeCrypto,
            transactionFeeInFiat: quidaxFeeInNaira + adminFeeInNaira,
            totalCostInCrypto,
            totalCostInFiat,
            totalToReceiveInFiat: assetValueInNaira,
            currency: "NGN",
            bankDetail,
            ...(internal && { totalCryptoToAdmin }),
        };
    }

    async createInstantSwap(user: User, dto: PlaceInstantSwapRequestDto) {
        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "Please complete your account setup or contact admin for support",
                HttpStatus.BAD_REQUEST
            );
        }

        const swapInfo = await this.quidaxService.createInstantSwapRequest(
            user.cryptoSubAccountId,
            {
                from_currency: dto.from_currency,
                to_currency: dto.to_currency,
                ...(dto.from_amount && {
                    from_amount: dto.from_amount.toString(),
                }),
                ...(dto.to_amount && { to_amount: dto.to_amount?.toString() }),
            }
        );

        return buildResponse({
            message: "Swap request quote retrieved successfully",
            data: swapInfo.data,
        });
    }

    async refreshInstantSwap(user: User, dto: RefreshInstantSwapRequestDto) {
        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "Please complete your account setup or contact admin for support",
                HttpStatus.BAD_REQUEST
            );
        }

        const swapInfo = await this.quidaxService.refreshInstantSwapQuote(
            user.cryptoSubAccountId,
            dto.quotation_id,
            {
                from_currency: dto.from_currency,
                to_currency: dto.to_currency,
                ...(dto.from_amount && {
                    from_amount: dto.from_amount.toString(),
                }),
                ...(dto.to_amount && { to_amount: dto.to_amount?.toString() }),
            }
        );

        return buildResponse({
            message: "Swap request quote retrieved successfully",
            data: swapInfo.data,
        });
    }

    async withdrawerRequest(user: User, dto: WithdrawerRequestDto) {
        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "Please complete your account setup or contact admin for support",
                HttpStatus.BAD_REQUEST
            );
        }

        const reference = generateId({ type: "reference" });
        const requestRes = await this.quidaxService.createWithdrawerRequest({
            amount: dto.amount.toString(),
            currency: dto.currency,
            narration: dto.narration,
            transaction_note: dto.transaction_note,
            user_id: user.cryptoSubAccountId,
            fund_uid: dto.recipientWalletAddress, //receiving wallet address
            fund_uid2: dto.destinationTag, // destination tag
            reference: reference,
        });

        const amtFiat = await this.getAmountInNaira(
            requestRes.data.currency,
            Number(requestRes.data.amount),
            "sell"
        );

        const createdOrder = await this.prisma.order.create({
            data: {
                orderCategory: OrderCategory.SEND,
                status: OrderStatus.processing,
                streamlinedStatus: getStreamlinedStatus(OrderStatus.processing),
                orderReference: reference,
                transactionId: generateId({ type: "transaction" }),
                providerOrderId: requestRes.data.id,
                userId: user.id,
                currency: requestRes.data.currency,
                narration: requestRes.data.narration,
                transaction_note: requestRes.data.transaction_note,
                recipient: requestRes.data.recipient.details.address,
                amount: +requestRes.data.amount,
                fee: +requestRes.data.fee,
                total: +requestRes.data.total,
                sourceType: requestRes.data.type,
                amountInFiat: amtFiat?.amount,
                rateAtConversion: amtFiat?.rate,
            },
        });

        return buildResponse({
            message: "Withdrawer request placed successfully",
            data: {
                ...requestRes.data,
                transactionId: createdOrder.transactionId,
            },
        });
    }

    async cancelWithdrawerRequest(user: User, dto: CancelWithdrawerRequestDto) {
        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "Please complete your account setup or contact admin for support",
                HttpStatus.BAD_REQUEST
            );
        }

        const requestRes = await this.quidaxService.cancelWithdrawerRequest({
            user_id: user.cryptoSubAccountId,
            withdrawal_id: dto.withdrawal_id,
        });

        return buildResponse({
            message: "Withdrawer cancel request placed successfully",
            data: requestRes.data,
        });
    }

    async cancelOrder(user: User, orderId: number) {
        // Find the order
        const order = await this.prisma.order.findFirst({
            where: {
                id: orderId,
                userId: user.id,
            },
        });

        if (!order) {
            throw new TransactionNotFoundException(
                "Order not found",
                HttpStatus.NOT_FOUND
            );
        }

        // Check if order is pending
        if (order.streamlinedStatus !== "pending") {
            throw new GeneralTransactionException(
                "Only pending orders can be cancelled",
                HttpStatus.BAD_REQUEST
            );
        }

        // Update order status to cancelled
        const updatedOrder = await this.prisma.order.update({
            where: { id: orderId },
            data: {
                status: OrderStatus.cancelled,
                streamlinedStatus: "cancelled",
            },
        });

        return buildResponse({
            message: "Order cancelled successfully",
            data: {
                orderId: updatedOrder.id,
                status: updatedOrder.status,
                streamlinedStatus: updatedOrder.streamlinedStatus,
            },
        });
    }

    async confirmInstantSwapQuote(user: User, dto: ConfirmInstantSwapQuoteDto) {
        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "Please complete your account setup or contact admin for support",
                HttpStatus.BAD_REQUEST
            );
        }

        const swapInfo = await this.quidaxService.confirmInstantSwap({
            quotation_id: dto.quotationId,
            user_id: user.cryptoSubAccountId,
        });

        const amtFiat = await this.getAmountInNaira(
            swapInfo.data.from_currency,
            Number(swapInfo.data?.from_amount),
            "sell"
        );
        const transactionId = generateId({ type: "transaction" });
        if (swapInfo.data) {
            this.prisma.$transaction(
                async (tx) => {
                    await tx.order.create({
                        data: {
                            orderCategory: OrderCategory.SWAP,
                            status: swapInfo.data.status,
                            streamlinedStatus: getStreamlinedStatus(swapInfo.data.status),
                            transactionId: transactionId,
                            providerOrderId: swapInfo.data.id,
                            orderReference: generateId({
                                type: "reference",
                            }),
                            userId: user.id,
                            fromCurrency:
                                swapInfo.data.from_currency.toUpperCase(),
                            toCurrency: swapInfo.data.to_currency.toUpperCase(),
                            fromAmount: +swapInfo.data?.from_amount,
                            toAmount: +swapInfo.data?.received_amount,
                            amount: +swapInfo.data?.from_amount,
                            quotationId: swapInfo.data.swap_quotation.id,
                            quoted_currency:
                                swapInfo.data.swap_quotation.quoted_currency,
                            quoted_price:
                                +swapInfo.data.swap_quotation.quoted_price,
                            executionPrice: +swapInfo.data.execution_price,
                            amountInFiat: amtFiat?.amount,
                            rateAtConversion: amtFiat?.rate,
                        },
                    });
                },
                { maxWait: 5000, timeout: 20000 }
            );
        }

        return buildResponse({
            message: "Swap request processed successfully",
            data: {
                ...swapInfo.data,
                transactionId: transactionId,
            },
        });
    }

    async verifySwapQuoteTransaction(
        swap_transaction_id: string,
        user_id: string
    ) {
        const result = await this.quidaxService.getSwapTransaction({
            swap_transaction_id,
            user_id,
        });
        return result;
    }

    async getWithdrawerTransactionByReference(
        reference: string,
        user_id: string
    ) {
        const result = await this.quidaxService.getWithdrawerByReference({
            user_id,
            reference,
        });
        return result;
    }

    async triggerQuidaxAccountCreation(user: User) {
        // Run synchronously instead of using queue for reliability
        try {
            let cryptoSubAccountId = user.cryptoSubAccountId;

            // If user doesn't have a crypto sub-account, create or find existing one
            if (!cryptoSubAccountId) {
                this.logger.log(`Creating/finding crypto account for user ${user.id} (${user.email})`);
                
                // Use createOrFindSubAccount to handle existing accounts gracefully
                let result;
                try {
                    result = await this.quidaxService.createOrFindSubAccount({
                        email: user.email,
                        first_name: user.firstName,
                        last_name: user.lastName,
                    });
                } catch (quidaxError) {
                    this.logger.error(`Quidax createOrFindSubAccount failed: ${quidaxError?.message}`, quidaxError?.stack);
                    throw new Error(`Quidax API error: ${quidaxError?.message}`);
                }

                if (result.status !== "success") {
                    this.logger.error(`Sub-account creation/lookup failed: ${JSON.stringify(result)}`);
                    throw new Error("Failed to create or find sub-account");
                }

                cryptoSubAccountId = result.data.id;

                await this.prisma.user.update({
                    where: { id: user.id },
                    data: { cryptoSubAccountId },
                });

                this.logger.log(`Sub-account ID stored: ${cryptoSubAccountId}`);
            } else {
                this.logger.log(`User ${user.id} already has crypto sub-account: ${cryptoSubAccountId}, ensuring wallets exist`);
            }

            // Check if AssetWallet records already exist for all currencies
            // Supported cryptocurrencies with full Quidax wallet support
            const currencies = [
                "btc",   // Bitcoin
                "eth",   // Ethereum
                "usdt",  // Tether
                "usdc",  // USD Coin
                "bnb",   // Binance Coin
                "sol",   // Solana
                "xrp",   // Ripple
                "ada",   // Cardano
                "doge",  // Dogecoin
                "ltc",   // Litecoin
                "trx",   // Tron
                "shib",  // Shiba Inu
            ];
            const existingWallets = await this.prisma.assetWallet.findMany({
                where: {
                    userId: user.id,
                    assetCurrency: { in: currencies.map(c => c.toUpperCase()) },
                },
                select: { assetCurrency: true, addressSynced: true },
            });
            const existingCurrencies = new Set(existingWallets.map(w => w.assetCurrency.toLowerCase()));
            
            // Find currencies that don't have AssetWallet records yet
            const missingCurrencies = currencies.filter(c => !existingCurrencies.has(c));
            
            // Find currencies that have wallets but no addresses synced
            const walletsNeedingAddresses = existingWallets
                .filter(w => !w.addressSynced)
                .map(w => w.assetCurrency.toLowerCase());
            
            // Combine: create new wallets + generate addresses for existing wallets without addresses
            const currenciesToProcess = [...new Set([...missingCurrencies, ...walletsNeedingAddresses])];
            
            if (currenciesToProcess.length === 0) {
                this.logger.log(`User ${user.id} already has all AssetWallet records with addresses, skipping`);
                return buildResponse({
                    message: `account already fully set up`,
                    data: { walletResults: currencies.map(c => ({ currency: c, success: true, existing: true })) },
                });
            }
            
            this.logger.log(`User ${user.id} needs processing for: ${currenciesToProcess.join(', ')}`);
            const walletResults = [];

            for (const currency of currenciesToProcess) {
                try {
                    this.logger.log(`Creating wallet for ${currency.toUpperCase()}...`);
                    const addresses = await this.ensureWalletPaymentAddresses({
                        userId: user.id,
                        cryptoSubAccountId,
                        assetSymbol: currency.toUpperCase(),
                    });
                    this.logger.log(`Wallet created for ${currency.toUpperCase()}: ${addresses?.length || 0} addresses`);
                    
                    // Also create/update AssetWallet record directly (don't wait for webhook)
                    try {
                        const walletData = await this.quidaxService.getUserWallet({
                            user_id: cryptoSubAccountId,
                            currency: currency.toLowerCase(),
                        });
                        
                        if (walletData.status === "success" && walletData.data) {
                            const data = walletData.data;
                            await this.prisma.assetWallet.upsert({
                                where: {
                                    userId_assetCurrency: {
                                        userId: user.id,
                                        assetCurrency: currency.toUpperCase(),
                                    },
                                },
                                update: {
                                    quidaxWalletId: data.id,
                                    assetName: data.name,
                                    balance: data.balance,
                                    locked: data.locked,
                                    staked: data.staked,
                                    convertedBalance: data.converted_balance,
                                    blockchainEnabled: data.blockchain_enabled,
                                    defaultNetwork: data.default_network,
                                    isCrypto: data.is_crypto,
                                    networks: data.networks,
                                    referenceCurrency: data.reference_currency,
                                    depositAddress: data.deposit_address,
                                    destinationTag: data.destination_tag,
                                    ...(data.deposit_address && { addressSynced: true }),
                                    ...(data.deposit_address && { isActive: true }),
                                },
                                create: {
                                    quidaxWalletId: data.id,
                                    assetCurrency: data.currency.toUpperCase(),
                                    assetName: data.name,
                                    balance: data.balance,
                                    locked: data.locked,
                                    staked: data.staked,
                                    convertedBalance: data.converted_balance,
                                    blockchainEnabled: data.blockchain_enabled,
                                    defaultNetwork: data.default_network,
                                    isCrypto: data.is_crypto,
                                    networks: data.networks,
                                    referenceCurrency: data.reference_currency,
                                    depositAddress: data.deposit_address,
                                    destinationTag: data.destination_tag,
                                    userId: user.id,
                                    ...(data.deposit_address && { addressSynced: true }),
                                    ...(data.deposit_address && { isActive: true }),
                                },
                            });
                            this.logger.log(`AssetWallet created/updated for ${currency.toUpperCase()}`);
                        }
                    } catch (assetError) {
                        this.logger.error(`Failed to create AssetWallet for ${currency}: ${assetError?.message}`);
                    }
                    
                    walletResults.push({ currency, success: true, addresses: addresses?.length || 0 });
                } catch (error) {
                    this.logger.error(`Address creation error for ${currency}: ${error?.message}`, error?.stack);
                    walletResults.push({ currency, success: false, error: error?.message });
                }
            }

            const successCount = walletResults.filter(r => r.success).length;
            this.logger.log(`Wallet creation summary: ${successCount}/${currencies.length} successful`);

            return buildResponse({
                message: `account generation completed (${successCount}/${currencies.length} wallets created)`,
                data: { walletResults },
            });
        } catch (error) {
            this.logger.error(`triggerQuidaxAccountCreation failed: ${error?.message}`, error?.stack);
            throw error;
        }
    }

    // Handles successful wallet address creation webhook from Quidax
    async walletAddressCreatedSuccessHandler(
        data: IWalletAddressCreatedSuccess
    ) {
        // Step 1: Find the associated crypto wallet address record using the ID from the webhook
        const walletAddress = await this.prisma.cryptoWalletAddress.findUnique({
            where: { walletAddressId: data.walletAddressId },
            select: {
                id: true,
                assetSymbol: true,
                network: true,
                user: { select: { id: true, cryptoSubAccountId: true } },
            },
        });

        // Step 2: If wallet address is not found, throw an error
        if (!walletAddress) {
            this.logger.error("Crypto Wallet Address Record not found");
            return;
        }

        // Step 3: Check if an asset wallet already exists for this user and asset
        const assetWallet = await this.prisma.assetWallet.findUnique({
            where: {
                userId_assetCurrency: {
                    userId: walletAddress.user.id,
                    assetCurrency: walletAddress.assetSymbol.toUpperCase(),
                },
            },
            select: {
                id: true,
                quidaxWalletId: true,
                user: { select: { cryptoSubAccountId: true } },
            },
        });

        // Step 4: If no asset wallet exists, fetch wallet data from Quidax and create a new asset wallet
        if (!assetWallet) {
            const { status, data } = await this.quidaxService.getUserWallet({
                user_id: walletAddress.user.cryptoSubAccountId,
                currency: walletAddress.assetSymbol.toLowerCase(),
            });

            if (status === "success") {
                await this.prisma.assetWallet.upsert({
                    where: {
                        userId_assetCurrency: {
                            userId: walletAddress.user.id,
                            assetCurrency:
                                walletAddress.assetSymbol.toUpperCase(),
                        },
                    },
                    update: {
                        quidaxWalletId: data.id,
                        assetName: data.name,
                        balance: data.balance,
                        locked: data.locked,
                        staked: data.staked,
                        convertedBalance: data.converted_balance,
                        blockchainEnabled: data.blockchain_enabled,
                        defaultNetwork: data.default_network,
                        isCrypto: data.is_crypto,
                        networks: data.networks,
                        referenceCurrency: data.reference_currency,
                        depositAddress: data.deposit_address,
                        destinationTag: data.destination_tag,
                        ...(data.deposit_address && { addressSynced: true }),
                        ...(data.deposit_address && { isActive: true }),
                    },
                    create: {
                        quidaxWalletId: data.id, // Quidax wallet ID
                        assetCurrency: data.currency.toUpperCase(),
                        assetName: data.name,
                        balance: data.balance,
                        locked: data.locked,
                        staked: data.staked,
                        convertedBalance: data.converted_balance,
                        blockchainEnabled: data.blockchain_enabled,
                        defaultNetwork: data.default_network,
                        isCrypto: data.is_crypto,
                        networks: data.networks, // List of network objects with deposit/withdraw status
                        referenceCurrency: data.reference_currency,
                        depositAddress: data.deposit_address, // Can be null initially
                        destinationTag: data.destination_tag,
                        userId: walletAddress.user.id,
                        ...(data.deposit_address && { addressSynced: true }), // Mark address as synced if present
                        ...(data.deposit_address && { isActive: true }), // Mark wallet as active if deposit address exists
                    },
                });

                this.logWalletFlow(
                    "walletAddressCreatedSuccessHandler:asset_wallet_synced",
                    {
                        userId: walletAddress.user.id,
                        asset: walletAddress.assetSymbol,
                        walletId: data.id,
                    }
                );
            }
        }

        const webhookNetwork = this.normalizeNetworkInput(data.network);
        console.log("webhook network", webhookNetwork);

        if (
            walletAddress.network &&
            webhookNetwork &&
            walletAddress.network !== webhookNetwork
        ) {
            this.logger.warn(
                `Incoming network ${webhookNetwork} differs from stored network ${walletAddress.network} for wallet ${data.walletAddressId}`
            );
        }

        // Step 5: Update the crypto wallet address record with the new address and mark it active
        await this.prisma.cryptoWalletAddress.update({
            where: { id: walletAddress.id },
            data: {
                address: data.walletAddress,
                ...(data.totalPayments && {
                    totalPayments: data.totalPayments, // Optional field if available
                }),
                destination_tag: data.destination_tag,
                status: CryptoWalletStatus.ACTIVE, // Mark as active
                lastSyncedAt: new Date(), // Timestamp of the last sync
                ...(webhookNetwork &&
                    !walletAddress.network && {
                        network: webhookNetwork,
                    }),
            },
        });
    }

    async getGeneratedWalletAddress(data: GetPaymentAddressByIdOptions) {
        const result = await this.quidaxService.getPaymentAddressById(data);
        return result;
    }

    async walletUpdatedHandler(data: IWalletUpdated) {
        const wallet = await this.prisma.assetWallet.findUnique({
            where: { quidaxWalletId: data.walletId },
        });

        if (!wallet) {
            throw new WalletAddressNotFoundException(
                "Crypto Wallet Record not found",
                HttpStatus.NOT_FOUND
            );
        }

        await this.prisma.assetWallet.update({
            where: { id: wallet.id },
            data: {
                balance: data.balance,
                locked: data.locked,
                staked: data.staked,
                convertedBalance: data.convertedBalance,
                updatedAt: new Date(data.updatedAt),
                depositAddress: data.depositAddress, // Can be null initially
                destinationTag: data.destinationTag,
                ...(data.depositAddress && { addressSynced: true }), // Mark address as synced if present
                ...(data.depositAddress && { isActive: true }), // Mark wallet as active if deposit address exists
            },
        });
    }

    async depositHandler(options: DepositTransaction) {
        const user = await this.prisma.user.findUnique({
            where: { cryptoSubAccountId: options.quidaxUserId },
        });

        if (!user) {
            this.logger.error(
                `User not found for deposit | ${JSON.stringify({
                    quidaxUserId: options.quidaxUserId,
                    referenceId: options.referenceId,
                })}`
            );
            return buildResponse({
                message: "User not found for deposit transaction",
            });
        }

        // Validate that the payment address exists in our database
        const paymentAddress = await this.prisma.cryptoWalletAddress.findUnique(
            {
                where: { walletAddressId: options.payment_address_id },
                select: {
                    id: true,
                    userId: true,
                    assetSymbol: true,
                    network: true,
                    address: true,
                },
            }
        );

        if (!paymentAddress) {
            this.logger.error(
                `Payment address not found in database | ${JSON.stringify({
                    payment_address_id: options.payment_address_id,
                    network: options.network,
                    currency: options.currency,
                    amount: options.amount,
                })}`
            );
            return buildResponse({
                message: "Payment address not found in database",
            });
        }

        // Verify the payment address belongs to this user
        if (paymentAddress.userId !== user.id) {
            this.logger.error(
                `Payment address does not belong to user | ${JSON.stringify({
                    paymentAddressUserId: paymentAddress.userId,
                    expectedUserId: user.id,
                    payment_address_id: options.payment_address_id,
                })}`
            );
            return buildResponse({
                message: "Payment address does not belong to user",
            });
        }

        this.logger.log(
            `Processing deposit | ${JSON.stringify({
                userId: user.id,
                currency: options.currency,
                amount: options.amount,
                network: options.network,
                paymentAddressId: options.payment_address_id,
                status: options.status,
            })}`
        );

        if (user) {
            const transaction = await this.prisma.order.findUnique({
                where: { providerOrderId: options.referenceId },
            });

            if (!transaction) {
                const amtFiat = await this.getAmountInNaira(
                    options.currency,
                    Number(options.amount),
                    "buy"
                );

                const transactionId = generateId({ type: "transaction" });
                await this.prisma.order.create({
                    data: {
                        orderCategory: OrderCategory.RECEIVE,
                        status: options.status,
                        transactionId: transactionId,
                        streamlinedStatus: getStreamlinedStatus(options.status),
                        providerOrderId: options.referenceId,
                        blockchain_txid: options.txid,
                        userId: user.id,
                        currency: options.currency.toUpperCase(),
                        reason: options.reason,
                        recipient: options.recipient,
                        sender: options.payment_address,
                        amount: +options.amount,
                        fee: +options.fee,
                        sourceType: options.type,
                        amountInFiat: amtFiat?.amount,
                        rateAtConversion: amtFiat?.rate,
                    },
                });

                if (options.status == OrderStatus.accepted) {
                    // Update user's wallet balance
                    const assetWallet = await this.prisma.assetWallet.findUnique({
                        where: {
                            userId_assetCurrency: {
                                userId: user.id,
                                assetCurrency: options.currency.toUpperCase(),
                            },
                        },
                    });

                    if (assetWallet) {
                        const currentBalance = parseFloat(assetWallet.balance.toString());
                        const depositAmount = parseFloat(options.amount);
                        const newBalance = (currentBalance + depositAmount).toString();

                        await this.prisma.assetWallet.update({
                            where: { id: assetWallet.id },
                            data: { balance: newBalance },
                        });

                        this.logger.log(
                            `Wallet balance updated | ${JSON.stringify({
                                userId: user.id,
                                currency: options.currency,
                                oldBalance: assetWallet.balance.toString(),
                                depositAmount: options.amount,
                                newBalance: newBalance,
                            })}`
                        );
                    }

                    const message = this.notificationMessage.receiveTransaction(
                        {
                            amount: +options.amount,
                            currency: options.currency.toUpperCase(),
                            transactionId: transactionId,
                            sender: options.payment_address,
                        }
                    );

                    const createdNotification =
                        await this.prisma.notification.create({
                            data: {
                                title: "You've received a new payment",
                                body: message,
                                userId: user.id,
                                target: UserNotificationTarget.SINGLE,
                                beneficiary: NotificationBeneficiary.INDIVIDUAL,
                                type: NotificationType.MESSAGE,
                                status: NotificationStatus.APPROVED,
                                senderId: null,
                                transactionType: OrderCategory.RECEIVE,
                                currency: options.currency.toUpperCase(),
                            },
                        });

                    this.notificationEvent.emit("transaction_notification", {
                        email: user.email,
                        notice: message,
                    });

                    const notificationList =
                        await this.prisma.notification.findMany({
                            where: { userId: user.id },
                            orderBy: { createdAt: "desc" },
                            take: 20,
                        });

                    this.wsGateway.notifyUser(user.id, {
                        type: "new_notification",
                        notification: createdNotification,
                        notificationList,
                    });
                }
            } else {
                await this.prisma.order.update({
                    where: { id: transaction.id },
                    data: { 
                        status: options.status,
                        streamlinedStatus: getStreamlinedStatus(options.status),
                    },
                });

                if (options.status == OrderStatus.accepted && transaction.status !== OrderStatus.accepted) {
                    // Update user's wallet balance (only if not already accepted)
                    const assetWallet = await this.prisma.assetWallet.findUnique({
                        where: {
                            userId_assetCurrency: {
                                userId: user.id,
                                assetCurrency: options.currency.toUpperCase(),
                            },
                        },
                    });

                    if (assetWallet) {
                        const currentBalance = parseFloat(assetWallet.balance.toString());
                        const depositAmount = parseFloat(options.amount);
                        const newBalance = (currentBalance + depositAmount).toString();

                        await this.prisma.assetWallet.update({
                            where: { id: assetWallet.id },
                            data: { balance: newBalance },
                        });

                        this.logger.log(
                            `Wallet balance updated | ${JSON.stringify({
                                userId: user.id,
                                currency: options.currency,
                                oldBalance: assetWallet.balance.toString(),
                                depositAmount: options.amount,
                                newBalance: newBalance,
                            })}`
                        );
                    }

                    const message = this.notificationMessage.receiveTransaction(
                        {
                            amount: +options.amount,
                            currency: options.currency.toUpperCase(),
                            transactionId: transaction.transactionId,
                            sender: options.payment_address,
                        }
                    );

                    const createdNotification =
                        await this.prisma.notification.create({
                            data: {
                                title: "You've received a new payment",
                                body: message,
                                userId: user.id,
                                target: UserNotificationTarget.SINGLE,
                                beneficiary: NotificationBeneficiary.INDIVIDUAL,
                                type: NotificationType.MESSAGE,
                                status: NotificationStatus.APPROVED,
                                senderId: null,
                                transactionType: OrderCategory.RECEIVE,
                                currency: options.currency.toUpperCase(),
                            },
                        });

                    this.notificationEvent.emit("transaction_notification", {
                        email: user.email,
                        notice: message,
                    });

                    const notificationList =
                        await this.prisma.notification.findMany({
                            where: { userId: user.id },
                            orderBy: { createdAt: "desc" },
                            take: 20,
                        });

                    this.wsGateway.notifyUser(user.id, {
                        type: "new_notification",
                        notification: createdNotification,
                        notificationList,
                    });
                }
            }
        }

        return buildResponse({
            message: "Deposit transaction logged successfully",
        });
    }

    async swapTransactionHandler(options: SwapTransactionHandlerOptions) {
        const transaction = await this.prisma.order.findUnique({
            where: { providerOrderId: options.orderId },
            include: { user: true },
        });

        if (!transaction) {
            throw new TransactionNotFoundException(
                "Transaction not found",
                HttpStatus.NOT_FOUND
            );
        }

        if (transaction.status === OrderStatus.completed) {
            throw new TransactionCompletedException(
                "Transaction already completed",
                HttpStatus.BAD_REQUEST
            );
        }

        if (transaction.status === options.status) {
            return;
        }
        await this.prisma.order.update({
            where: { id: transaction.id },
            data: {
                status: options.status,
                streamlinedStatus: getStreamlinedStatus(options.status),
            },
        });

        if (options.status == OrderStatus.completed) {
            const message = this.notificationMessage.swapTransactionSuccess({
                fromAmount: transaction.fromAmount,
                fromCurrency: transaction.fromCurrency,
                toAmount: transaction.toAmount,
                toCurrency: transaction.toCurrency,
                transactionId: transaction.transactionId,
            });

            const createdNotification = await this.prisma.notification.create({
                data: {
                    title: "Your swap transaction is completed",
                    body: message,
                    userId: transaction.user.id,
                    target: UserNotificationTarget.SINGLE,
                    beneficiary: NotificationBeneficiary.INDIVIDUAL,
                    type: NotificationType.MESSAGE,
                    status: NotificationStatus.APPROVED,
                    senderId: null,
                    transactionType: transaction.orderCategory,
                    currency: transaction.toCurrency,
                },
            });

            this.notificationEvent.emit("transaction_notification", {
                email: transaction.user.email,
                notice: message,
            });

            const notificationList = await this.prisma.notification.findMany({
                where: { userId: transaction.user.id },
                orderBy: { createdAt: "desc" },
                take: 20,
            });

            this.wsGateway.notifyUser(transaction.user.id, {
                type: "new_notification",
                notification: createdNotification,
                notificationList,
            });
        }
    }

    async withdrawerTransactionHandler(
        options: WithdrawerTransactionHandlerOptions
    ) {
        const transaction = await this.prisma.order.findUnique({
            where: { orderReference: options.orderReference },
            include: {
                user: { select: { id: true, email: true, userType: true } },
            },
        });

        if (!transaction) {
            throw new TransactionNotFoundException(
                "Transaction not found",
                HttpStatus.NOT_FOUND
            );
        }

        if (transaction.status === OrderStatus.done) {
            throw new TransactionCompletedException(
                "Transaction already completed",
                HttpStatus.BAD_REQUEST
            );
        }

        if (transaction.status === options.status) {
            return;
        }

        await this.prisma.order.update({
            where: { id: transaction.id },
            data: {
                status: options.status,
                streamlinedStatus: getStreamlinedStatus(options.status),
            },
        });

        //asset has been moved to admin wallet for a buy and seller needs to be paid
        if (
            options.status === OrderStatus.done &&
            transaction.orderCategory === OrderCategory.SELL
        ) {
            await this.fincraService.initializeTransfer({
                accountName: transaction.destinationBankAccountName,
                accountNumber: transaction.destinationBankAccountNumber,
                amount: transaction.totalToReceiveInFiat,
                bankCode: transaction.destinationBankCode,
                bankName: transaction.destinationBankName,
                serviceCharge: 0,
                userId: transaction.userId,
                orderId: transaction.id,
                reference: generateId({ type: "reference" }),
            });

            //follow up: listen to the transfer event and update transaction record accordingly
        }

        if (options.status == OrderStatus.done) {
            const message = this.notificationMessage.sendTransactionSuccess({
                amount: transaction.amount,
                currency: transaction.currency,
                recipient: transaction.recipient,
                transactionId: transaction.transactionId,
            });

            const createdNotification = await this.prisma.notification.create({
                data: {
                    title: "Your send transaction is done",
                    body: message,
                    userId: transaction.user.id,
                    target: UserNotificationTarget.SINGLE,
                    beneficiary: NotificationBeneficiary.INDIVIDUAL,
                    type: NotificationType.MESSAGE,
                    status: NotificationStatus.APPROVED,
                    senderId: null,
                    transactionType: transaction.orderCategory,
                    currency: transaction.currency,
                },
            });

            this.notificationEvent.emit("transaction_notification", {
                email: transaction.user.email,
                notice: message,
            });

            const notificationList = await this.prisma.notification.findMany({
                where: { userId: transaction.user.id },
                orderBy: { createdAt: "desc" },
                take: 20,
            });

            this.wsGateway.notifyUser(transaction.user.id, {
                type: "new_notification",
                notification: createdNotification,
                notificationList,
            });
        }
    }

    async getFee(
        amount: number,
        data: any
    ): Promise<{ fee: number; type: string }> {
        if (data.type === "flat" && typeof data.fee === "number") {
            return {
                fee: data.fee,
                type: "flat",
            };
        }

        if (data.type === "percentage" && typeof data.fee === "number") {
            return {
                fee: (amount * data.fee) / 100,
                type: "percentage",
            };
        }

        if (data.type === "range" && Array.isArray(data.fee)) {
            for (const range of data.fee) {
                if (amount >= range.min && amount < range.max) {
                    if (range.type === "percentage") {
                        return {
                            fee: (amount * range.value) / 100,
                            type: "percentage",
                        };
                    } else {
                        return {
                            fee: range.value,
                            type: "flat",
                        };
                    }
                }
            }

            throw new OutOfRangeException(
                "Amount is out of range.",
                HttpStatus.BAD_REQUEST
            );
        }

        throw new UnknownFeeStructureException(
            `Unknown fee type or structure. Received data: ${JSON.stringify(
                data
            )}`,
            HttpStatus.INTERNAL_SERVER_ERROR
        );
    }

    async getAmountInNaira(
        asset: string,
        amount: number,
        rateType: "buy" | "sell" | "last" = "buy"
    ): Promise<{ amount?: number; rate?: number } | null> {
        const referenceCurrency = "ngn";
        const assetCurrency = asset.toLowerCase();
        const marketSymbol = `${assetCurrency}${referenceCurrency}`;
        const marketData = await this.quidaxService.getSingleMarketTicker(
            marketSymbol
        );

        const ticker = marketData.data?.ticker;
        if (!ticker) return null;

        const rate = parseFloat(ticker[rateType]);
        if (isNaN(rate)) return null;

        return {
            amount: amount * rate,
            rate: rate,
        };
    }

    /**
     * Get market chart data for an asset including price history and market statistics
     * HYBRID APPROACH: LiveCoinWatch for prices/charts, CoinGecko for ATH/ATL only (7-day cache)
     */
    async getMarketChart(asset: string, days: number = 7) {
        console.log(`📊 [Hybrid] Getting market chart for ${asset} (${days} days)`);

        // Fetch from LiveCoinWatch and CoinGecko (ATH/ATL only) in parallel
        const [lcwMarketData, lcwHistory, athAtlData] = await Promise.all([
            this.liveCoinWatchService.getMarketData(asset).catch(err => {
                console.warn(`⚠️ [LCW] Market data fetch failed:`, err.message);
                return null;
            }),
            this.liveCoinWatchService.getHistoricalData(asset, days).catch(err => {
                console.warn(`⚠️ [LCW] History fetch failed:`, err.message);
                return null;
            }),
            this.coinGeckoService.getAthAtl(asset).catch(err => {
                console.warn(`⚠️ [CG] ATH/ATL fetch failed:`, err.message);
                return { ath: null, ath_date: null, atl: null, atl_date: null };
            }),
        ]);

        // Build market_data from LiveCoinWatch + CoinGecko ATH/ATL
        const market_data = {
            current_price: lcwMarketData?.rate || null,
            market_cap: lcwMarketData?.cap || null,
            total_volume: lcwMarketData?.volume || null,
            high_24h: lcwHistory?.high24h || null,
            low_24h: lcwHistory?.low24h || null,
            price_change_percentage_24h: lcwMarketData?.delta?.day 
                ? (lcwMarketData.delta.day - 1) * 100 
                : null,
            price_change_percentage_7d: lcwMarketData?.delta?.week 
                ? (lcwMarketData.delta.week - 1) * 100 
                : null,
            price_change_percentage_30d: lcwMarketData?.delta?.month 
                ? (lcwMarketData.delta.month - 1) * 100 
                : null,
            circulating_supply: lcwMarketData?.circulatingSupply || null,
            max_supply: lcwMarketData?.maxSupply || null,
            // ATH/ATL from CoinGecko (7-day cache)
            ath: athAtlData.ath,
            ath_date: athAtlData.ath_date,
            atl: athAtlData.atl,
            atl_date: athAtlData.atl_date,
        };

        return buildResponse({
            message: "Market chart data retrieved",
            data: {
                asset: asset.toUpperCase(),
                days,
                prices: lcwHistory?.prices || [],
                market_data,
            },
        });
    }

    /**
     * Get sparkline data (7-day mini charts) for multiple assets
     * Uses LiveCoinWatch for sparklines
     */
    async getBatchSparklines(assets: string[]) {
        const sparklines = await this.liveCoinWatchService.getBatchSparklines(assets);

        return buildResponse({
            message: "Sparkline data retrieved",
            data: sparklines,
        });
    }
}
