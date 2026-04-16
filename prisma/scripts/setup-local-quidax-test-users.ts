/**
 * Provision Quidax sub-accounts and wallet rows for local Docker test users.
 *
 * This script is development-only and idempotent:
 * - It reuses an already-linked Quidax sub-account when possible.
 * - It creates a sub-account if the local test user has none.
 * - It removes stale wallet/address rows for local test users that have wallet
 *   state but no stored cryptoSubAccountId before reprovisioning.
 *
 * Run with: npx ts-node prisma/scripts/setup-local-quidax-test-users.ts
 */

import "dotenv/config";
import {
    CryptoWalletStatus,
    NetworkTypes,
    PrismaClient,
    UserType,
} from "@prisma/client";
import {
    QuidaxLib,
    QuidaxValidationError,
    type GetUserWalletResponse,
} from "../../src/libs/quidax";

const prisma = new PrismaClient({ log: ["error", "warn"] });

const LOCAL_TEST_QUIDAX_ELIGIBLE_EMAILS = [
    "tier0.test@flipxer.local",
    "tier1.test@flipxer.local",
    "tier2.test@flipxer.local",
    "tier3.test@flipxer.local",
    "blocked.test@flipxer.local",
    "locked.test@flipxer.local",
    "twofactor.test@flipxer.local",
    "kyc-pending.test@flipxer.local",
    "kyc-declined.test@flipxer.local",
    "business.test@flipxer.local",
] as const;
const AUTO_PROVISION_DISABLED_VALUES = new Set(["0", "false", "no", "off"]);
const SUPPORTED_CURRENCIES = [
    "btc",
    "eth",
    "usdt",
    "usdc",
    "bnb",
    "sol",
    "xrp",
    "ada",
    "doge",
    "ltc",
    "trx",
    "shib",
] as const;
const SUPPORTED_CURRENCY_SET = new Set(SUPPORTED_CURRENCIES);
const QUIDAX_USER_EXISTS_ERROR_CODE = "E0101";
const NETWORK_SEGMENT_SPLITTER = /[\s/_-]+/;
const NETWORK_ALIAS_MAP: Record<string, NetworkTypes> = {
    trc20: NetworkTypes.trc20,
    tron: NetworkTypes.trc20,
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
const SUPPORTED_NETWORK_SET = new Set<string>(Object.values(NetworkTypes));

type LocalTestUser = {
    id: number;
    email: string;
    firstName: string | null;
    lastName: string | null;
    cryptoSubAccountId: string | null;
    userType: UserType;
};

type ProvisionResult = {
    email: string;
    status: "success" | "failed" | "skipped";
    subAccountId?: string;
    subAccountMode?: string;
    cleanedAssetWallets?: number;
    cleanedCryptoWalletAddresses?: number;
    syncedWallets?: number;
    syncedAddresses?: number;
    failedCurrencies?: string[];
    error?: string;
};

type SyncWalletRowsResult = {
    syncedWallets: number;
    syncedAddresses: number;
    failedCurrencies: string[];
};

type PaymentAddressSnapshot = {
    id: string;
    address: string | null;
    destination_tag: string | null;
    total_payments: string | null;
    network: string | null;
};

function isDevelopmentEnvironment(): boolean {
    return (process.env.NODE_ENV ?? "development") === "development";
}

function isAutoProvisionEnabled(): boolean {
    const rawValue = process.env.LOCAL_TEST_QUIDAX_AUTO_PROVISION;

    if (!rawValue) {
        return true;
    }

    return !AUTO_PROVISION_DISABLED_VALUES.has(rawValue.trim().toLowerCase());
}

function getQuidaxClient(): QuidaxLib | null {
    const baseURL = process.env.QUIDAX_BASE_URL?.trim();
    const rampBaseURL = process.env.QUIDAX_RAMP_BASEURL?.trim();
    const apiPublic = process.env.QUIDAX_API_PUBLIC?.trim() ?? "local-dev";
    const apiSecret = process.env.QUIDAX_API_SECRET?.trim();

    if (!baseURL || !rampBaseURL || !apiSecret) {
        console.warn(
            "Skipping local Quidax test-user provisioning because QUIDAX_BASE_URL, QUIDAX_RAMP_BASEURL, or QUIDAX_API_SECRET is missing.",
        );
        return null;
    }

    return new QuidaxLib({
        baseURL,
        rampBaseURL,
        api_public: apiPublic,
        api_secret: apiSecret,
    });
}

function normalizeNetworkInput(network?: string | null): NetworkTypes | null {
    if (!network) {
        return null;
    }

    const trimmed = network.trim().toLowerCase();

    if (!trimmed) {
        return null;
    }

    const directMatch =
        NETWORK_ALIAS_MAP[trimmed] ||
        (SUPPORTED_NETWORK_SET.has(trimmed)
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
            (SUPPORTED_NETWORK_SET.has(segment)
                ? (segment as NetworkTypes)
                : null);

        if (alias) {
            return alias;
        }
    }

    return null;
}

function extractDepositEnabledNetworkMap(
    wallet: GetUserWalletResponse,
): Map<NetworkTypes, string> {
    const depositEnabledMap = new Map<NetworkTypes, string>();

    const register = (candidate?: string | null) => {
        if (!candidate?.trim()) {
            return;
        }

        const normalized = normalizeNetworkInput(candidate);

        if (!normalized) {
            return;
        }

        depositEnabledMap.set(normalized, candidate.trim().toLowerCase());
    };

    const networks = wallet.networks ?? [];

    if (wallet.default_network) {
        const defaultNetworkInfo = networks.find(
            (network) => network.id === wallet.default_network,
        );

        if (!defaultNetworkInfo || defaultNetworkInfo.deposits_enabled) {
            register(wallet.default_network);
        }
    }

    for (const network of networks) {
        if (!network.deposits_enabled) {
            continue;
        }

        register(network.id);
    }

    return depositEnabledMap;
}

function generateAliasedEmail(email: string): string {
    const normalizedEmail = email.toLowerCase().trim();
    const [localPart, domain] = normalizedEmail.split("@");
    const timestamp = Date.now().toString().slice(-6);
    const isGmail = domain === "gmail.com" || domain === "googlemail.com";

    if (isGmail) {
        return `${localPart}+flip${timestamp}@${domain}`;
    }

    return `${localPart}.flip${timestamp}@${domain}`;
}

function getQuidaxNameParts(user: LocalTestUser): {
    first_name: string;
    last_name: string;
} {
    const firstName = user.firstName?.trim();
    const lastName = user.lastName?.trim();

    return {
        first_name: firstName || "Local",
        last_name: lastName || `User${user.id}`,
    };
}

async function getLocalTestUsers(): Promise<LocalTestUser[]> {
    return prisma.user.findMany({
        where: {
            email: { in: [...LOCAL_TEST_QUIDAX_ELIGIBLE_EMAILS] },
            userType: {
                notIn: [UserType.ADMIN, UserType.SUPER_ADMIN],
            },
            isDeleted: false,
        },
        orderBy: { id: "asc" },
        select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            cryptoSubAccountId: true,
            userType: true,
        },
    });
}

async function cleanupOrphanWalletState(user: LocalTestUser): Promise<{
    assetWallets: number;
    cryptoWalletAddresses: number;
}> {
    const [assetWallets, cryptoWalletAddresses] = await prisma.$transaction([
        prisma.assetWallet.count({ where: { userId: user.id } }),
        prisma.cryptoWalletAddress.count({ where: { userId: user.id } }),
    ]);

    if (assetWallets === 0 && cryptoWalletAddresses === 0) {
        return { assetWallets: 0, cryptoWalletAddresses: 0 };
    }

    await prisma.$transaction([
        prisma.cryptoWalletAddress.deleteMany({ where: { userId: user.id } }),
        prisma.assetWallet.deleteMany({ where: { userId: user.id } }),
    ]);

    return { assetWallets, cryptoWalletAddresses };
}

async function getValidatedLinkedSubAccount(
    quidax: QuidaxLib,
    user: LocalTestUser,
): Promise<string | null> {
    if (!user.cryptoSubAccountId) {
        return null;
    }

    try {
        const linkedAccount = await quidax.getAccountDetail({
            user_id: user.cryptoSubAccountId,
        });

        if (linkedAccount.status === "success" && linkedAccount.data?.id) {
            return linkedAccount.data.id;
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
            `Linked Quidax sub-account lookup failed for ${user.email}. Falling back to email lookup/create. ${message}`,
        );
    }

    return null;
}

async function resolveDuplicateEmailSubAccount(
    quidax: QuidaxLib,
    user: LocalTestUser,
    error: unknown,
): Promise<{ subAccountId: string; mode: string }> {
    if (
        !(error instanceof QuidaxValidationError) ||
        error.code !== QUIDAX_USER_EXISTS_ERROR_CODE
    ) {
        throw error;
    }

    const retryAccount = await quidax.findSubAccountByEmail(user.email);
    if (retryAccount?.id) {
        return {
            subAccountId: retryAccount.id,
            mode: "existing-email-retry",
        };
    }

    const aliasedEmail = generateAliasedEmail(user.email);
    const aliasedAccount = await quidax.createSubAccount({
        email: aliasedEmail,
        ...getQuidaxNameParts(user),
    });

    return {
        subAccountId: aliasedAccount.data.id,
        mode: `created-aliased:${aliasedEmail}`,
    };
}

async function createFreshSubAccount(
    quidax: QuidaxLib,
    user: LocalTestUser,
): Promise<{ subAccountId: string; mode: string }> {
    const createOptions = {
        email: user.email,
        ...getQuidaxNameParts(user),
    };

    try {
        const createdAccount = await quidax.createSubAccount(createOptions);
        return {
            subAccountId: createdAccount.data.id,
            mode: "created",
        };
    } catch (error) {
        return resolveDuplicateEmailSubAccount(quidax, user, error);
    }
}

async function ensureLinkedSubAccount(
    quidax: QuidaxLib,
    user: LocalTestUser,
): Promise<{ subAccountId: string; mode: string }> {
    const linkedSubAccountId = await getValidatedLinkedSubAccount(quidax, user);
    if (linkedSubAccountId) {
        return {
            subAccountId: linkedSubAccountId,
            mode: "existing-linked",
        };
    }

    const existingAccount = await quidax.findSubAccountByEmail(user.email);
    if (existingAccount?.id) {
        return {
            subAccountId: existingAccount.id,
            mode: "existing-email",
        };
    }

    return createFreshSubAccount(quidax, user);
}

async function persistLinkedSubAccount(userId: number, subAccountId: string): Promise<void> {
    await prisma.user.update({
        where: { id: userId },
        data: { cryptoSubAccountId: subAccountId },
    });
}

function mapWalletRecord(
    wallet: GetUserWalletResponse,
    fallback?: { depositAddress?: string | null; destinationTag?: string | null },
) {
    const resolvedDepositAddress =
        wallet.deposit_address || fallback?.depositAddress || null;
    const resolvedDestinationTag =
        wallet.destination_tag ?? fallback?.destinationTag ?? null;
    const hasDepositAddress = Boolean(resolvedDepositAddress);

    return {
        quidaxWalletId: wallet.id,
        assetName: wallet.name || wallet.currency.toUpperCase(),
        assetCurrency: wallet.currency.toUpperCase(),
        balance: wallet.balance || "0",
        locked: wallet.locked || "0",
        staked: wallet.staked || "0",
        convertedBalance: wallet.converted_balance || "0",
        referenceCurrency: (wallet.reference_currency || "ngn").toUpperCase(),
        isCrypto: wallet.is_crypto,
        defaultNetwork: wallet.default_network || wallet.currency.toLowerCase(),
        blockchainEnabled: wallet.blockchain_enabled,
        depositAddress: resolvedDepositAddress,
        destinationTag: resolvedDestinationTag,
        networks: wallet.networks || [],
        isActive: hasDepositAddress,
        addressSynced: hasDepositAddress,
    };
}

async function upsertAssetWalletRecord(
    userId: number,
    wallet: GetUserWalletResponse,
    fallback?: { depositAddress?: string | null; destinationTag?: string | null },
): Promise<void> {
    const walletData = mapWalletRecord(wallet, fallback);

    await prisma.assetWallet.upsert({
        where: {
            userId_assetCurrency: {
                userId,
                assetCurrency: walletData.assetCurrency,
            },
        },
        update: walletData,
        create: {
            userId,
            ...walletData,
        },
    });
}

async function persistCryptoWalletAddress(options: {
    userId: number;
    assetSymbol: string;
    network: NetworkTypes;
    providerAddress: PaymentAddressSnapshot;
}): Promise<void> {
    const { userId, assetSymbol, network, providerAddress } = options;
    const address = providerAddress.address?.trim() || null;
    const data = {
        walletAddressId: providerAddress.id,
        network,
        address,
        destination_tag: providerAddress.destination_tag ?? null,
        totalPayments: providerAddress.total_payments?.trim() || "0",
        status: address
            ? CryptoWalletStatus.ACTIVE
            : CryptoWalletStatus.PENDING,
        lastSyncedAt: address ? new Date() : null,
    };

    const existingByWalletAddressId = await prisma.cryptoWalletAddress.findUnique({
        where: { walletAddressId: providerAddress.id },
        select: { id: true },
    });

    if (existingByWalletAddressId) {
        await prisma.cryptoWalletAddress.update({
            where: { id: existingByWalletAddressId.id },
            data,
        });
        return;
    }

    await prisma.cryptoWalletAddress.upsert({
        where: {
            userId_assetSymbol_network: {
                userId,
                assetSymbol,
                network,
            },
        },
        update: data,
        create: {
            userId,
            assetSymbol,
            ...data,
        },
    });
}

async function hydratePaymentAddress(
    quidax: QuidaxLib,
    subAccountId: string,
    currency: string,
    address: PaymentAddressSnapshot,
): Promise<PaymentAddressSnapshot> {
    if (address.address?.trim()) {
        return address;
    }

    try {
        const response = await quidax.getPaymentAddressById({
            user_id: subAccountId,
            currency,
            address_id: address.id,
        });

        return {
            id: response.data.id,
            address: response.data.address,
            destination_tag: response.data.destination_tag,
            total_payments: response.data.total_payments,
            network: response.data.network,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
            `Payment address hydration failed for ${currency.toUpperCase()} (${address.id}): ${message}`,
        );
        return address;
    }
}

async function applyDefaultWalletAddressFallback(
    userId: number,
    assetSymbol: string,
    wallet: GetUserWalletResponse,
): Promise<void> {
    if (!wallet.deposit_address) {
        return;
    }

    const defaultNetwork = normalizeNetworkInput(wallet.default_network);

    if (!defaultNetwork) {
        return;
    }

    await prisma.cryptoWalletAddress.updateMany({
        where: {
            userId,
            assetSymbol,
            network: defaultNetwork,
            address: null,
        },
        data: {
            address: wallet.deposit_address,
            destination_tag: wallet.destination_tag,
            status: CryptoWalletStatus.ACTIVE,
            lastSyncedAt: new Date(),
        },
    });
}

async function getDefaultNetworkAddressFallback(
    userId: number,
    assetSymbol: string,
    defaultNetwork?: string | null,
): Promise<{ depositAddress: string | null; destinationTag: string | null }> {
    const normalizedDefaultNetwork = normalizeNetworkInput(defaultNetwork);

    if (!normalizedDefaultNetwork) {
        return {
            depositAddress: null,
            destinationTag: null,
        };
    }

    const defaultAddress = await prisma.cryptoWalletAddress.findUnique({
        where: {
            userId_assetSymbol_network: {
                userId,
                assetSymbol,
                network: normalizedDefaultNetwork,
            },
        },
        select: {
            address: true,
            destination_tag: true,
        },
    });

    return {
        depositAddress: defaultAddress?.address ?? null,
        destinationTag: defaultAddress?.destination_tag ?? null,
    };
}

async function syncWalletAddressesForCurrency(
    quidax: QuidaxLib,
    user: LocalTestUser,
    subAccountId: string,
    currency: (typeof SUPPORTED_CURRENCIES)[number],
): Promise<number> {
    const walletResponse = await quidax.getUserWallet({
        user_id: subAccountId,
        currency,
    });
    const wallet = walletResponse.data;

    if (!wallet) {
        throw new Error(`Quidax did not return wallet data for ${currency.toUpperCase()}`);
    }

    const assetSymbol = wallet.currency.toUpperCase();
    const depositEnabledNetworkMap = extractDepositEnabledNetworkMap(wallet);
    const existingNetworks = new Set<NetworkTypes>();
    let syncedAddresses = 0;

    try {
        const providerAddressResponse = await quidax.getPaymentAddressList({
            user_id: subAccountId,
            currency,
        });

        for (const providerAddress of providerAddressResponse.data ?? []) {
            const hydratedProviderAddress = await hydratePaymentAddress(
                quidax,
                subAccountId,
                currency,
                {
                    id: providerAddress.id,
                    address: providerAddress.address,
                    destination_tag: providerAddress.destination_tag,
                    total_payments: providerAddress.total_payments,
                    network: providerAddress.network,
                },
            );
            const normalizedNetwork = normalizeNetworkInput(
                hydratedProviderAddress.network,
            );

            if (!normalizedNetwork || !depositEnabledNetworkMap.has(normalizedNetwork)) {
                continue;
            }

            await persistCryptoWalletAddress({
                userId: user.id,
                assetSymbol,
                network: normalizedNetwork,
                providerAddress: hydratedProviderAddress,
            });

            existingNetworks.add(normalizedNetwork);
            syncedAddresses += 1;
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
            `Payment address list lookup failed for ${user.email} ${assetSymbol}: ${message}`,
        );
    }

    for (const [network, providerNetwork] of depositEnabledNetworkMap.entries()) {
        if (existingNetworks.has(network)) {
            continue;
        }

        const creationResponse = await quidax.createPaymentAddress({
            user_id: subAccountId,
            currency,
            network: providerNetwork,
        });
        const hydratedAddress = await hydratePaymentAddress(quidax, subAccountId, currency, {
            id: creationResponse.data.id,
            address: creationResponse.data.address,
            destination_tag: creationResponse.data.destination_tag,
            total_payments: creationResponse.data.total_payments,
            network: creationResponse.data.network,
        });
        const normalizedCreatedNetwork =
            normalizeNetworkInput(hydratedAddress.network) || network;

        await persistCryptoWalletAddress({
            userId: user.id,
            assetSymbol,
            network: normalizedCreatedNetwork,
            providerAddress: hydratedAddress,
        });

        existingNetworks.add(normalizedCreatedNetwork);
        syncedAddresses += 1;
    }

    const refreshedWalletResponse = await quidax.getUserWallet({
        user_id: subAccountId,
        currency,
    });
    const refreshedWallet = refreshedWalletResponse.data ?? wallet;

    await applyDefaultWalletAddressFallback(user.id, assetSymbol, refreshedWallet);

    const defaultAddressFallback = await getDefaultNetworkAddressFallback(
        user.id,
        assetSymbol,
        refreshedWallet.default_network,
    );

    await upsertAssetWalletRecord(user.id, refreshedWallet, defaultAddressFallback);

    return syncedAddresses;
}

async function getCurrenciesNeedingFollowUp(
    userId: number,
): Promise<(typeof SUPPORTED_CURRENCIES)[number][]> {
    const [assetWallets, cryptoWalletAddresses] = await prisma.$transaction([
        prisma.assetWallet.findMany({
            where: {
                userId,
                addressSynced: false,
            },
            select: {
                assetCurrency: true,
            },
        }),
        prisma.cryptoWalletAddress.findMany({
            where: {
                userId,
                address: null,
            },
            select: {
                assetSymbol: true,
            },
        }),
    ]);

    const currencies = new Set<string>();

    for (const wallet of assetWallets) {
        currencies.add(wallet.assetCurrency.toLowerCase());
    }

    for (const address of cryptoWalletAddresses) {
        currencies.add(address.assetSymbol.toLowerCase());
    }

    return [...currencies].filter(
        (currency): currency is (typeof SUPPORTED_CURRENCIES)[number] =>
            SUPPORTED_CURRENCY_SET.has(
                currency as (typeof SUPPORTED_CURRENCIES)[number],
            ),
    );
}

async function syncWalletRows(
    quidax: QuidaxLib,
    user: LocalTestUser,
    subAccountId: string,
): Promise<SyncWalletRowsResult> {
    const walletList = await quidax.getUserWalletList({ user_id: subAccountId });
    const supportedCurrencies = [
        ...new Set(
            (walletList.data ?? [])
                .map((wallet) => wallet.currency.toLowerCase())
                .filter((currency): currency is (typeof SUPPORTED_CURRENCIES)[number] =>
                    SUPPORTED_CURRENCY_SET.has(
                        currency as (typeof SUPPORTED_CURRENCIES)[number],
                    ),
                ),
        ),
    ];

    const syncedWalletCurrencySet = new Set<string>();
    let syncedAddresses = 0;
    const failedCurrencySet = new Set<string>();

    for (const currency of supportedCurrencies) {
        try {
            syncedAddresses += await syncWalletAddressesForCurrency(
                quidax,
                user,
                subAccountId,
                currency,
            );
            syncedWalletCurrencySet.add(currency.toUpperCase());
            failedCurrencySet.delete(currency.toUpperCase());
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failedCurrencySet.add(currency.toUpperCase());
            console.warn(
                `Wallet provisioning failed for ${user.email} ${currency.toUpperCase()}: ${message}`,
            );
        }
    }

    const followUpCurrencies = await getCurrenciesNeedingFollowUp(user.id);

    for (const currency of followUpCurrencies) {
        try {
            syncedAddresses += await syncWalletAddressesForCurrency(
                quidax,
                user,
                subAccountId,
                currency,
            );
            syncedWalletCurrencySet.add(currency.toUpperCase());
            failedCurrencySet.delete(currency.toUpperCase());
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failedCurrencySet.add(currency.toUpperCase());
            console.warn(
                `Wallet follow-up provisioning failed for ${user.email} ${currency.toUpperCase()}: ${message}`,
            );
        }
    }

    return {
        syncedWallets: syncedWalletCurrencySet.size,
        syncedAddresses,
        failedCurrencies: [...failedCurrencySet],
    };
}

async function provisionLocalTestUser(
    quidax: QuidaxLib,
    user: LocalTestUser,
): Promise<ProvisionResult> {
    let cleanedAssetWallets = 0;
    let cleanedCryptoWalletAddresses = 0;

    if (!user.cryptoSubAccountId) {
        const cleanup = await cleanupOrphanWalletState(user);
        cleanedAssetWallets = cleanup.assetWallets;
        cleanedCryptoWalletAddresses = cleanup.cryptoWalletAddresses;
    }

    const { subAccountId, mode } = await ensureLinkedSubAccount(quidax, user);

    if (user.cryptoSubAccountId !== subAccountId) {
        await persistLinkedSubAccount(user.id, subAccountId);
    }

    const walletSyncResult = await syncWalletRows(quidax, user, subAccountId);
    const status = walletSyncResult.failedCurrencies.length ? "failed" : "success";
    const error = walletSyncResult.failedCurrencies.length
        ? `Failed currencies: ${walletSyncResult.failedCurrencies.join(", ")}`
        : undefined;

    return {
        email: user.email,
        status,
        subAccountId,
        subAccountMode: mode,
        cleanedAssetWallets,
        cleanedCryptoWalletAddresses,
        syncedWallets: walletSyncResult.syncedWallets,
        syncedAddresses: walletSyncResult.syncedAddresses,
        failedCurrencies: walletSyncResult.failedCurrencies,
        error,
    };
}

async function main() {
    console.log("\n=== Provisioning local Quidax test users ===\n");

    if (!isDevelopmentEnvironment()) {
        console.log("Skipping Quidax test-user provisioning because NODE_ENV is not development.");
        return;
    }

    if (!isAutoProvisionEnabled()) {
        console.log("Skipping Quidax test-user provisioning because LOCAL_TEST_QUIDAX_AUTO_PROVISION is disabled.");
        return;
    }

    const quidax = getQuidaxClient();
    if (!quidax) {
        return;
    }

    const users = await getLocalTestUsers();

    if (users.length === 0) {
        console.log("No eligible local Docker test users found.");
        return;
    }

    const results: ProvisionResult[] = [];

    for (const user of users) {
        try {
            const result = await provisionLocalTestUser(quidax, user);
            results.push(result);

            if (result.status === "success") {
                console.log(
                    `  ✓ ${user.email} | subAccount=${result.subAccountId} | mode=${result.subAccountMode} | wallets=${result.syncedWallets} | addresses=${result.syncedAddresses ?? 0} | cleaned wallets=${result.cleanedAssetWallets ?? 0} | cleaned addresses=${result.cleanedCryptoWalletAddresses ?? 0}`,
                );
                continue;
            }

            console.error(
                `  ✗ ${user.email} | subAccount=${result.subAccountId} | mode=${result.subAccountMode} | wallets=${result.syncedWallets ?? 0} | addresses=${result.syncedAddresses ?? 0} | ${result.error}`,
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            results.push({
                email: user.email,
                status: "failed",
                error: message,
            });
            console.error(`  ✗ ${user.email} | ${message}`);
        }
    }

    const successCount = results.filter((result) => result.status === "success").length;
    const failureCount = results.filter((result) => result.status === "failed").length;
    const totalWalletsSynced = results.reduce(
        (sum, result) => sum + (result.syncedWallets ?? 0),
        0,
    );
    const totalAddressesSynced = results.reduce(
        (sum, result) => sum + (result.syncedAddresses ?? 0),
        0,
    );
    const totalWalletsCleaned = results.reduce(
        (sum, result) => sum + (result.cleanedAssetWallets ?? 0),
        0,
    );
    const totalAddressesCleaned = results.reduce(
        (sum, result) => sum + (result.cleanedCryptoWalletAddresses ?? 0),
        0,
    );

    console.log("\n=== Local Quidax test-user provisioning summary ===");
    console.log(`Users processed: ${results.length}`);
    console.log(`Successful: ${successCount}`);
    console.log(`Failed: ${failureCount}`);
    console.log(`Wallet rows synced: ${totalWalletsSynced}`);
    console.log(`Payment addresses synced: ${totalAddressesSynced}`);
    console.log(`Orphan AssetWallet rows cleaned: ${totalWalletsCleaned}`);
    console.log(`Orphan CryptoWalletAddress rows cleaned: ${totalAddressesCleaned}`);

    if (failureCount > 0) {
        process.exitCode = 1;
    }
}

main()
    .catch((error) => {
        console.error("Fatal error while provisioning local Quidax test users:", error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });