import { Test, TestingModule } from "@nestjs/testing";

// Use type-only imports to avoid Prisma client generation at test time
type NetworkTypes = any;
type CryptoWalletStatus = any;
type CryptoWalletAddress = any;

const NetworkTypes = {
    erc20: "erc20",
    trc20: "trc20",
    btc: "btc",
    solana: "solana",
} as any;

const CryptoWalletStatus = {
    ACTIVE: "ACTIVE",
    PENDING: "PENDING",
    FAILED: "FAILED",
} as any;

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class {
        readonly __stub = true;
    },
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {
        status: number;
        constructor(msg: string, status: number) {
            super(msg);
            this.status = status;
        }
    },
    __esModule: true,
}));

import { WalletAddressService } from "../wallet-address.service";
import { PrismaService } from "@/modules/core/prisma/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { TradeHelpersService } from "../trade-helpers.service";

function makePrisma() {
    const tx = {
        cryptoWalletAddress: {
            upsert: jest.fn().mockResolvedValue({
                id: 10,
                network: NetworkTypes.erc20,
                address: "0xNewAddr",
                status: CryptoWalletStatus.ACTIVE,
            }),
        },
    };
    return {
        user: { findUnique: jest.fn() },
        assetWallet: { update: jest.fn() },
        cryptoWalletAddress: {
            findUnique: jest.fn(),
            findMany: jest.fn().mockResolvedValue([]),
            upsert: jest.fn(),
            deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        $transaction: jest.fn().mockImplementation(async (cb: any) => cb(tx)),
    };
}

const mockQuidax = {
    getUserWallet: jest.fn(),
    createPaymentAddress: jest.fn(),
    getPaymentAddressList: jest.fn().mockResolvedValue({ data: [] }),
    verifyAddress: jest.fn(),
};

const mockTradeHelpers = {
    safeJsonStringify: jest.fn().mockReturnValue("{}"),
    normalizeNetworkInput: jest
        .fn()
        .mockImplementation((input?: string | null) => {
            if (!input) return null;
            const lower = input.toLowerCase();
            if (lower.includes("erc20") || lower === "ethereum")
                return NetworkTypes.erc20;
            if (lower.includes("trc20") || lower === "tron")
                return NetworkTypes.trc20;
            if (lower === "btc" || lower === "bitcoin") return NetworkTypes.btc;
            if (lower === "sol" || lower === "solana")
                return NetworkTypes.solana;
            return null;
        }),
};

describe("WalletAddressService", () => {
    let service: WalletAddressService;
    let prisma: ReturnType<typeof makePrisma>;

    beforeEach(async () => {
        prisma = makePrisma();
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                WalletAddressService,
                { provide: PrismaService, useValue: prisma },
                { provide: TradingInjectionToken.QUIDAX, useValue: mockQuidax },
                { provide: TradeHelpersService, useValue: mockTradeHelpers },
            ],
        }).compile();

        service = module.get(WalletAddressService);
    });

    afterEach(() => jest.clearAllMocks());

    // ── syncWallet ───────────────────────────────────────────

    describe("syncWallet", () => {
        it("should sync wallet metadata from Quidax", async () => {
            prisma.user.findUnique.mockResolvedValue({
                cryptoSubAccountId: "qx-123",
            });
            mockQuidax.getUserWallet.mockResolvedValue({
                data: {
                    deposit_address: "0xABC",
                    destination_tag: null,
                    default_network: "erc20",
                    networks: [],
                    blockchain_enabled: true,
                },
            });

            await service.syncWallet(1, "ETH");

            expect(prisma.assetWallet.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: {
                        userId_assetCurrency: {
                            userId: 1,
                            assetCurrency: "ETH",
                        },
                    },
                    data: expect.objectContaining({ depositAddress: "0xABC" }),
                }),
            );
        });

        it("should return early if user has no crypto sub-account", async () => {
            prisma.user.findUnique.mockResolvedValue({
                cryptoSubAccountId: null,
            });

            await service.syncWallet(1, "ETH");

            expect(mockQuidax.getUserWallet).not.toHaveBeenCalled();
        });

        it("should not throw on sync failure", async () => {
            prisma.user.findUnique.mockResolvedValue({
                cryptoSubAccountId: "qx-123",
            });
            mockQuidax.getUserWallet.mockRejectedValue(
                new Error("Network error"),
            );

            await expect(service.syncWallet(1, "ETH")).resolves.toBeUndefined();
        });
    });

    // ── extractDepositEnabledNetworkMap ──────────────────────

    describe("extractDepositEnabledNetworkMap", () => {
        it("should register deposit-enabled networks", () => {
            const wallet: any = {
                currency: "eth",
                default_network: "erc20",
                networks: [
                    { id: "erc20", deposits_enabled: true },
                    { id: "trc20", deposits_enabled: true },
                ],
            };

            const result = service.extractDepositEnabledNetworkMap(wallet);

            expect(result.size).toBe(2);
            expect(result.has(NetworkTypes.erc20)).toBe(true);
            expect(result.has(NetworkTypes.trc20)).toBe(true);
        });

        it("should skip deposit-disabled networks", () => {
            const wallet: any = {
                currency: "usdt",
                default_network: "erc20",
                networks: [
                    { id: "erc20", deposits_enabled: true },
                    { id: "trc20", deposits_enabled: false },
                ],
            };

            const result = service.extractDepositEnabledNetworkMap(wallet);

            expect(result.has(NetworkTypes.erc20)).toBe(true);
            expect(result.has(NetworkTypes.trc20)).toBe(false);
        });

        it("should handle wallet with no networks array", () => {
            const wallet: any = {
                currency: "btc",
                default_network: "btc",
                networks: undefined,
            };

            const result = service.extractDepositEnabledNetworkMap(wallet);

            // Should still register default network
            expect(result.has(NetworkTypes.btc)).toBe(true);
        });

        it("should skip empty and unsupported network candidates", () => {
            const wallet: any = {
                currency: "usdt",
                default_network: "   ",
                networks: [{ id: "mystery-chain", deposits_enabled: true }],
            };

            const result = service.extractDepositEnabledNetworkMap(wallet);

            expect(result.size).toBe(0);
        });
    });

    // ── getWalletAddress ─────────────────────────────────────

    describe("getWalletAddress", () => {
        it("should return a wallet by asset and network", async () => {
            const wallet = {
                id: 1,
                address: "0xABC",
                network: NetworkTypes.erc20,
                assetSymbol: "ETH",
            };
            prisma.cryptoWalletAddress.findUnique.mockResolvedValue(wallet);

            const result = await service.getWalletAddress(1, {
                asset: "eth",
                network: NetworkTypes.erc20,
            } as any);

            expect(result.data).toEqual(wallet);
            expect(result.message).toContain("wallet info retrieved");
        });

        it("should return null data when wallet not found", async () => {
            prisma.cryptoWalletAddress.findUnique.mockResolvedValue(null);

            const result = await service.getWalletAddress(1, {
                asset: "eth",
                network: NetworkTypes.erc20,
            } as any);

            expect(result.message).toContain("wallet info retrieved");
        });
    });

    // ── getWalletAddresses ───────────────────────────────────

    describe("getWalletAddresses", () => {
        it("should return all wallets for user and asset", async () => {
            const wallets = [
                { id: 1, network: NetworkTypes.erc20 },
                { id: 2, network: NetworkTypes.trc20 },
            ];
            prisma.user.findUnique.mockResolvedValue({
                cryptoSubAccountId: null,
            });
            prisma.cryptoWalletAddress.findMany.mockResolvedValue(wallets);

            const result = await service.getWalletAddresses(1, {
                asset: "usdt",
            } as any);

            expect(result.data).toHaveLength(2);
            expect(prisma.cryptoWalletAddress.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        userId: 1,
                        assetSymbol: "USDT",
                        status: CryptoWalletStatus.ACTIVE,
                    }),
                }),
            );
        });
    });

    // ── verifyWalletAddress ──────────────────────────────────

    describe("verifyWalletAddress", () => {
        it("should call Quidax to verify address and return result", async () => {
            mockQuidax.verifyAddress.mockResolvedValue({
                data: { valid: true, currency: "btc" },
            });

            const result = await service.verifyWalletAddress({
                address: "bc1qxyz",
                currency: "btc",
                network: "btc",
            } as any);

            expect(mockQuidax.verifyAddress).toHaveBeenCalledWith({
                address: "bc1qxyz",
                currency: "btc",
                network: "btc",
            });
            expect(result.data).toEqual({ valid: true, currency: "btc" });
        });
    });

    // ── initiateWalletAddressCreation ────────────────────────

    describe("initiateWalletAddressCreation", () => {
        it("should throw when user or sub-account not found", async () => {
            prisma.user.findUnique.mockResolvedValue(null);

            await expect(
                service.initiateWalletAddressCreation(1, {
                    asset: "btc",
                } as any),
            ).rejects.toThrow();
        });

        it("should create addresses for supported asset", async () => {
            prisma.user.findUnique.mockResolvedValue({
                id: 1,
                cryptoSubAccountId: "qx-123",
            });
            mockQuidax.getUserWallet.mockResolvedValue({
                data: {
                    currency: "btc",
                    default_network: "btc",
                    networks: [{ id: "btc", deposits_enabled: true }],
                },
            });
            mockQuidax.createPaymentAddress.mockResolvedValue({
                data: {
                    id: "addr-id-1",
                    network: "btc",
                    address: "bc1qNewAddress",
                    destination_tag: null,
                },
            });

            const result = await service.initiateWalletAddressCreation(1, {
                asset: "btc",
            } as any);

            expect(result.message).toContain("initiated");
        });

        it("should return already_created when no new addresses are created", async () => {
            prisma.user.findUnique.mockResolvedValue({
                id: 1,
                cryptoSubAccountId: "qx-123",
            });

            const spy = jest
                .spyOn(service, "ensureWalletPaymentAddresses")
                .mockResolvedValueOnce([] as any);

            const result = await service.initiateWalletAddressCreation(1, {
                asset: "btc",
            } as any);

            expect(result.message).toBe("wallet address already exists");
            expect(result.data.walletGenerationStatus).toBe("already_created");
            spy.mockRestore();
        });
    });

    // ── ensureWalletPaymentAddresses ─────────────────────────

    describe("ensureWalletPaymentAddresses", () => {
        it("should return empty array for unsupported asset", async () => {
            const result = await service.ensureWalletPaymentAddresses({
                userId: 1,
                cryptoSubAccountId: "qx-123",
                assetSymbol: "UNSUPPORTED_COIN",
            });

            expect(result).toEqual([]);
        });

        it("should return empty array when no wallet response from Quidax", async () => {
            mockQuidax.getUserWallet.mockResolvedValue({ data: null });

            const result = await service.ensureWalletPaymentAddresses({
                userId: 1,
                cryptoSubAccountId: "qx-123",
                assetSymbol: "BTC",
            });

            expect(result).toEqual([]);
        });

        it("should return existing addresses when all networks already exist", async () => {
            mockQuidax.getUserWallet.mockResolvedValue({
                data: {
                    currency: "eth",
                    default_network: "erc20",
                    networks: [{ id: "erc20", deposits_enabled: true }],
                },
            });
            prisma.cryptoWalletAddress.findMany.mockResolvedValue([
                { id: 1, network: NetworkTypes.erc20, address: "0xExisting" },
            ]);

            const result = await service.ensureWalletPaymentAddresses({
                userId: 1,
                cryptoSubAccountId: "qx-123",
                assetSymbol: "ETH",
            });

            expect(result).toHaveLength(1);
            expect(mockQuidax.createPaymentAddress).not.toHaveBeenCalled();
        });

        it("should return empty array when wallet has no deposit-enabled networks", async () => {
            mockQuidax.getUserWallet.mockResolvedValue({
                data: {
                    currency: "usdt",
                    default_network: "erc20",
                    networks: [{ id: "erc20", deposits_enabled: false }],
                },
            });

            const result = await service.ensureWalletPaymentAddresses({
                userId: 1,
                cryptoSubAccountId: "qx-123",
                assetSymbol: "USDT",
            });

            expect(result).toEqual([]);
            expect(mockQuidax.createPaymentAddress).not.toHaveBeenCalled();
        });

        it("should throw when requested network is unavailable", async () => {
            mockQuidax.getUserWallet.mockResolvedValue({
                data: {
                    currency: "usdt",
                    default_network: "erc20",
                    networks: [{ id: "erc20", deposits_enabled: true }],
                },
            });

            await expect(
                service.ensureWalletPaymentAddresses({
                    userId: 1,
                    cryptoSubAccountId: "qx-123",
                    assetSymbol: "USDT",
                    requestedNetworks: ["trc20"],
                }),
            ).rejects.toThrow("Network trc20 is not available for USDT");
        });

        it("should backfill provider addresses and keep successful creations when one network fails", async () => {
            mockQuidax.getUserWallet.mockResolvedValue({
                data: {
                    currency: "usdt",
                    default_network: "erc20",
                    networks: [
                        { id: "erc20", deposits_enabled: true },
                        { id: "trc20", deposits_enabled: true },
                        { id: "btc", deposits_enabled: true },
                    ],
                },
            });

            mockQuidax.getPaymentAddressList.mockResolvedValue({
                data: [
                    {
                        id: "provider-erc20",
                        network: "erc20",
                        address: "0xProvider",
                        destination_tag: null,
                    },
                ],
            });

            prisma.cryptoWalletAddress.upsert.mockResolvedValue({
                id: 99,
                network: NetworkTypes.erc20,
                address: "0xProvider",
                status: CryptoWalletStatus.ACTIVE,
            });

            mockQuidax.createPaymentAddress.mockImplementation(
                ({ network }: any) => {
                    if (network === "trc20") {
                        return Promise.resolve({
                            data: {
                                id: "new-trc20",
                                network: "trc20",
                                address: "TRXADDR",
                                destination_tag: null,
                            },
                        });
                    }

                    return Promise.reject(new Error("provider-failure"));
                },
            );

            const result = await service.ensureWalletPaymentAddresses({
                userId: 1,
                cryptoSubAccountId: "qx-123",
                assetSymbol: "USDT",
            });

            expect(prisma.cryptoWalletAddress.upsert).toHaveBeenCalled();
            expect(result.length).toBeGreaterThan(0);
        });

        it("should throw when all address creations fail", async () => {
            mockQuidax.getUserWallet.mockResolvedValue({
                data: {
                    currency: "btc",
                    default_network: "btc",
                    networks: [{ id: "btc", deposits_enabled: true }],
                },
            });

            mockQuidax.getPaymentAddressList.mockResolvedValue({ data: [] });
            mockQuidax.createPaymentAddress.mockResolvedValue({
                data: {
                    id: "bad-net",
                    network: "unknown-net",
                    address: "ADDR",
                    destination_tag: null,
                },
            });

            await expect(
                service.ensureWalletPaymentAddresses({
                    userId: 1,
                    cryptoSubAccountId: "qx-123",
                    assetSymbol: "BTC",
                }),
            ).rejects.toThrow("Failed to create wallet addresses");
        });

        it("should continue when provider address list fetch fails", async () => {
            mockQuidax.getUserWallet.mockResolvedValue({
                data: {
                    currency: "btc",
                    default_network: "btc",
                    networks: [{ id: "btc", deposits_enabled: true }],
                },
            });

            mockQuidax.getPaymentAddressList.mockRejectedValue(
                new Error("provider-list-failed"),
            );

            mockQuidax.createPaymentAddress.mockResolvedValue({
                data: {
                    id: "btc-created",
                    network: "btc",
                    address: "bc1xyz",
                    destination_tag: null,
                },
            });

            const result = await service.ensureWalletPaymentAddresses({
                userId: 1,
                cryptoSubAccountId: "qx-123",
                assetSymbol: "BTC",
            });

            expect(result.length).toBeGreaterThan(0);
        });

        it("should rethrow when persistence transaction fails", async () => {
            mockQuidax.getUserWallet.mockResolvedValue({
                data: {
                    currency: "btc",
                    default_network: "btc",
                    networks: [{ id: "btc", deposits_enabled: true }],
                },
            });
            mockQuidax.getPaymentAddressList.mockResolvedValue({ data: [] });
            mockQuidax.createPaymentAddress.mockResolvedValue({
                data: {
                    id: "btc-created",
                    network: "btc",
                    address: "bc1xyz",
                    destination_tag: null,
                },
            });

            prisma.$transaction.mockRejectedValueOnce(new Error("tx-failed"));

            await expect(
                service.ensureWalletPaymentAddresses({
                    userId: 1,
                    cryptoSubAccountId: "qx-123",
                    assetSymbol: "BTC",
                }),
            ).rejects.toThrow("tx-failed");
        });
        it("should skip provider address with null address during backfill", async () => {
            mockQuidax.getUserWallet.mockResolvedValue({
                data: {
                    currency: "usdt",
                    default_network: "erc20",
                    networks: [{ id: "erc20", deposits_enabled: true }],
                },
            });

            // Provider returns address with null address value
            mockQuidax.getPaymentAddressList.mockResolvedValue({
                data: [
                    {
                        id: "provider-erc20",
                        network: "erc20",
                        address: null, // ← null address should be skipped
                        destination_tag: null,
                    },
                ],
            });

            mockQuidax.createPaymentAddress.mockResolvedValue({
                data: {
                    id: "new-erc20",
                    network: "erc20",
                    address: "0xNewAddr",
                    destination_tag: null,
                },
            });

            const result = await service.ensureWalletPaymentAddresses({
                userId: 1,
                cryptoSubAccountId: "qx-123",
                assetSymbol: "USDT",
            });

            // Should still succeed via createPaymentAddress path
            expect(result.length).toBeGreaterThan(0);
            // upsert via backfill should not have been called with null address
            expect(prisma.cryptoWalletAddress.upsert).not.toHaveBeenCalledWith(
                expect.objectContaining({
                    create: expect.objectContaining({ address: null }),
                }),
            );
        });

        it("should continue gracefully when persistProviderAddress throws", async () => {
            mockQuidax.getUserWallet.mockResolvedValue({
                data: {
                    currency: "usdt",
                    default_network: "erc20",
                    networks: [
                        { id: "erc20", deposits_enabled: true },
                        { id: "trc20", deposits_enabled: true },
                    ],
                },
            });

            mockQuidax.getPaymentAddressList.mockResolvedValue({
                data: [
                    {
                        id: "provider-erc20",
                        network: "erc20",
                        address: "0xProvider",
                        destination_tag: null,
                    },
                ],
            });

            // Upsert throws on first call (erc20 backfill) but trc20 creation succeeds
            prisma.cryptoWalletAddress.upsert.mockRejectedValueOnce(
                new Error("upsert-failed"),
            );

            mockQuidax.createPaymentAddress.mockResolvedValue({
                data: {
                    id: "new-trc20",
                    network: "trc20",
                    address: "TRXADDR",
                    destination_tag: null,
                },
            });

            // Should not throw — persistProviderAddress catches and returns null
            await service.ensureWalletPaymentAddresses({
                userId: 1,
                cryptoSubAccountId: "qx-123",
                assetSymbol: "USDT",
            });
        });
    });

    // ── Extracted Helper Methods ─────────────────────────────

    describe("getOrFetchWalletResponse", () => {
        it("should return provided wallet data if available", async () => {
            const walletData = {
                currency: "eth",
                default_network: "erc20",
                networks: [{ id: "erc20", deposits_enabled: true }],
            } as any;

            const result = await (service as any).getOrFetchWalletResponse(
                walletData,
                "qx-123",
                "eth",
            );

            expect(result).toEqual(walletData);
            expect(mockQuidax.getUserWallet).not.toHaveBeenCalled();
        });

        it("should fetch wallet from Quidax if no provided data", async () => {
            const walletData = {
                currency: "btc",
                default_network: "btc",
                networks: [{ id: "btc", deposits_enabled: true }],
            };
            mockQuidax.getUserWallet.mockResolvedValue({ data: walletData });

            const result = await (service as any).getOrFetchWalletResponse(
                undefined,
                "qx-123",
                "btc",
            );

            expect(result).toEqual(walletData);
            expect(mockQuidax.getUserWallet).toHaveBeenCalledWith({
                user_id: "qx-123",
                currency: "btc",
            });
        });

        it("should return null when Quidax returns no data", async () => {
            mockQuidax.getUserWallet.mockResolvedValue({ data: null });

            const result = await (service as any).getOrFetchWalletResponse(
                undefined,
                "qx-123",
                "eth",
            );

            expect(result).toBeNull();
        });
    });

    describe("determineTargetNetworks", () => {
        it("should return all deposit-enabled networks by default", async () => {
            const depositMap = new Map([
                [NetworkTypes.erc20, "erc20"],
                [NetworkTypes.trc20, "trc20"],
            ]);

            const result = await (service as any).determineTargetNetworks({
                depositEnabledNetworkMap: depositMap,
                requestedNetworks: undefined,
                currency: "usdt",
                cryptoSubAccountId: "qx-123",
            });

            expect(result).toEqual([NetworkTypes.erc20, NetworkTypes.trc20]);
        });

        it("should filter to requested networks if provided", async () => {
            const depositMap = new Map([
                [NetworkTypes.erc20, "erc20"],
                [NetworkTypes.trc20, "trc20"],
            ]);

            const result = await (service as any).determineTargetNetworks({
                depositEnabledNetworkMap: depositMap,
                requestedNetworks: ["erc20"],
                currency: "usdt",
                cryptoSubAccountId: "qx-123",
            });

            expect(result).toContain(NetworkTypes.erc20);
            expect(result).not.toContain(NetworkTypes.trc20);
        });

        it("should throw when requested network is not available", async () => {
            const depositMap = new Map([[NetworkTypes.erc20, "erc20"]]);

            await expect(
                (service as any).determineTargetNetworks({
                    depositEnabledNetworkMap: depositMap,
                    requestedNetworks: ["trc20"],
                    currency: "usdt",
                    cryptoSubAccountId: "qx-123",
                }),
            ).rejects.toThrow("Network trc20 is not available");
        });
    });

    describe("buildExistingNetworkContext", () => {
        it("should return existing network set and default network", async () => {
            prisma.cryptoWalletAddress.findMany.mockResolvedValue([
                { network: NetworkTypes.erc20 },
                { network: NetworkTypes.trc20 },
            ]);

            const depositMap = new Map([
                [NetworkTypes.erc20, "erc20"],
                [NetworkTypes.trc20, "trc20"],
            ]);

            const result = await (service as any).buildExistingNetworkContext(
                1,
                "USDT",
                { default_network: "erc20" } as any,
                depositMap,
            );

            expect(result.existingNetworkSet.size).toBe(2);
            expect(result.existingNetworkSet.has(NetworkTypes.erc20)).toBe(
                true,
            ),
                expect(result.defaultNetworkNormalized).toBe(
                    NetworkTypes.erc20,
                );
        });

        it("should only return non-FAILED addresses", async () => {
            const depositMap = new Map([[NetworkTypes.erc20, "erc20"]]);

            await (service as any).buildExistingNetworkContext(
                1,
                "USDT",
                { default_network: "erc20" } as any,
                depositMap,
            );

            expect(prisma.cryptoWalletAddress.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        status: { not: CryptoWalletStatus.FAILED },
                    }),
                }),
            );
        });
    });

    describe("getExistingWalletAddresses", () => {
        it("should return all addresses for user and asset", async () => {
            const addresses = [
                { id: 1, network: NetworkTypes.erc20 },
                { id: 2, network: NetworkTypes.trc20 },
            ];
            prisma.cryptoWalletAddress.findMany.mockResolvedValue(addresses);

            const result = await (service as any).getExistingWalletAddresses(
                1,
                "USDT",
            );

            expect(result).toEqual(addresses);
            expect(prisma.cryptoWalletAddress.findMany).toHaveBeenCalledWith({
                where: {
                    userId: 1,
                    assetSymbol: "USDT",
                },
            });
        });
    });

    describe("deleteFailedRecordsForNetworks", () => {
        it("should delete FAILED records for specified networks", async () => {
            await (service as any).deleteFailedRecordsForNetworks(1, "USDT", [
                NetworkTypes.erc20,
            ]);

            expect(prisma.cryptoWalletAddress.deleteMany).toHaveBeenCalledWith({
                where: {
                    userId: 1,
                    assetSymbol: "USDT",
                    status: CryptoWalletStatus.FAILED,
                    network: { in: [NetworkTypes.erc20] },
                },
            });
        });

        it("should delete FAILED records for multiple networks", async () => {
            await (service as any).deleteFailedRecordsForNetworks(1, "USDT", [
                NetworkTypes.erc20,
                NetworkTypes.trc20,
            ]);

            expect(prisma.cryptoWalletAddress.deleteMany).toHaveBeenCalledWith({
                where: {
                    userId: 1,
                    assetSymbol: "USDT",
                    status: CryptoWalletStatus.FAILED,
                    network: { in: [NetworkTypes.erc20, NetworkTypes.trc20] },
                },
            });
        });

        it("should not call deleteMany when networks array is empty", async () => {
            await (service as any).deleteFailedRecordsForNetworks(
                1,
                "USDT",
                [],
            );

            expect(
                prisma.cryptoWalletAddress.deleteMany,
            ).not.toHaveBeenCalled();
        });
    });

    describe("createPaymentAddressForNetwork", () => {
        it("should create address for a specified network", async () => {
            mockQuidax.createPaymentAddress.mockResolvedValue({
                data: {
                    id: "addr-1",
                    network: "erc20",
                    address: "0xNEW",
                    destination_tag: null,
                },
            });

            const result = await (
                service as any
            ).createPaymentAddressForNetwork({
                network: NetworkTypes.erc20,
                depositEnabledNetworkMap: new Map([
                    [NetworkTypes.erc20, "erc20"],
                ]),
                cryptoSubAccountId: "qx-123",
                currency: "usdt",
                assetSymbolUpper: "USDT",
            });

            expect(result).toEqual({
                walletAddressId: "addr-1",
                network: NetworkTypes.erc20,
                address: "0xNEW",
                destination_tag: null,
            });
            expect(mockQuidax.createPaymentAddress).toHaveBeenCalledWith({
                user_id: "qx-123",
                currency: "usdt",
                network: "erc20",
            });
        });

        it("should throw when provider network mapping not found", async () => {
            await expect(
                (service as any).createPaymentAddressForNetwork({
                    network: NetworkTypes.erc20,
                    depositEnabledNetworkMap: new Map(),
                    cryptoSubAccountId: "qx-123",
                    currency: "usdt",
                    assetSymbolUpper: "USDT",
                }),
            ).rejects.toThrow("Unable to resolve provider network");
        });

        it("should throw when response network cannot be normalized", async () => {
            mockQuidax.createPaymentAddress.mockResolvedValue({
                data: {
                    id: "addr-1",
                    network: "unknown-net",
                    address: "0xNEW",
                    destination_tag: null,
                },
            });

            await expect(
                (service as any).createPaymentAddressForNetwork({
                    network: NetworkTypes.erc20,
                    depositEnabledNetworkMap: new Map([
                        [NetworkTypes.erc20, "erc20"],
                    ]),
                    cryptoSubAccountId: "qx-123",
                    currency: "usdt",
                    assetSymbolUpper: "USDT",
                }),
            ).rejects.toThrow("Unsupported network unknown-net returned");
        });
    });

    describe("filterSuccessfulCreations", () => {
        it("should filter only fulfilled results", () => {
            const results: PromiseSettledResult<any>[] = [
                {
                    status: "fulfilled",
                    value: { network: NetworkTypes.erc20, address: "0x1" },
                } as PromiseFulfilledResult<any>,
                {
                    status: "rejected",
                    reason: new Error("failed"),
                } as PromiseRejectedResult,
                {
                    status: "fulfilled",
                    value: { network: NetworkTypes.trc20, address: "0x2" },
                } as PromiseFulfilledResult<any>,
            ];

            const filtered = (service as any).filterSuccessfulCreations(
                results,
            );

            expect(filtered).toHaveLength(2);
            expect(filtered[0].value.network).toBe(NetworkTypes.erc20);
            expect(filtered[1].value.network).toBe(NetworkTypes.trc20);
        });

        it("should return empty array when all rejected", () => {
            const results: PromiseSettledResult<any>[] = [
                {
                    status: "rejected",
                    reason: new Error("failed1"),
                } as PromiseRejectedResult,
                {
                    status: "rejected",
                    reason: new Error("failed2"),
                } as PromiseRejectedResult,
            ];

            const filtered = (service as any).filterSuccessfulCreations(
                results,
            );

            expect(filtered).toHaveLength(0);
        });
    });

    describe("createAndPersistAddresses", () => {
        it("should create and persist successful addresses", async () => {
            mockQuidax.createPaymentAddress.mockResolvedValue({
                data: {
                    id: "addr-erc20",
                    network: "erc20",
                    address: "0xNEW",
                    destination_tag: null,
                },
            });

            prisma.$transaction.mockImplementation(async (cb) =>
                cb({
                    cryptoWalletAddress: {
                        upsert: jest.fn().mockResolvedValue({
                            id: 1,
                            network: NetworkTypes.erc20,
                            address: "0xNEW",
                        }),
                    },
                }),
            );

            const result = await (service as any).createAndPersistAddresses({
                networksToCreate: [NetworkTypes.erc20],
                depositEnabledNetworkMap: new Map([
                    [NetworkTypes.erc20, "erc20"],
                ]),
                cryptoSubAccountId: "qx-123",
                currency: "usdt",
                userId: 1,
                assetSymbolUpper: "USDT",
                backfilledProviderAddresses: [],
            });

            expect(result.length).toBeGreaterThan(0);
        });

        it("should throw when all creations fail", async () => {
            mockQuidax.createPaymentAddress.mockRejectedValue(
                new Error("provider-error"),
            );

            await expect(
                (service as any).createAndPersistAddresses({
                    networksToCreate: [NetworkTypes.erc20],
                    depositEnabledNetworkMap: new Map([
                        [NetworkTypes.erc20, "erc20"],
                    ]),
                    cryptoSubAccountId: "qx-123",
                    currency: "usdt",
                    userId: 1,
                    assetSymbolUpper: "USDT",
                    backfilledProviderAddresses: [],
                }),
            ).rejects.toThrow("Failed to create wallet addresses");
        });

        it("should include backfilled addresses in result", async () => {
            mockQuidax.createPaymentAddress.mockResolvedValue({
                data: {
                    id: "addr-trc20",
                    network: "trc20",
                    address: "TRXNEW",
                    destination_tag: null,
                },
            });

            const backfilled = [
                {
                    id: 1,
                    network: NetworkTypes.erc20,
                    address: "0xBACKFILL",
                } as CryptoWalletAddress,
            ];

            prisma.$transaction.mockImplementation(async (cb) =>
                cb({
                    cryptoWalletAddress: {
                        upsert: jest.fn().mockResolvedValue({
                            id: 2,
                            network: NetworkTypes.trc20,
                            address: "TRXNEW",
                        }),
                    },
                }),
            );

            const result = await (service as any).createAndPersistAddresses({
                networksToCreate: [NetworkTypes.trc20],
                depositEnabledNetworkMap: new Map([
                    [NetworkTypes.trc20, "trc20"],
                ]),
                cryptoSubAccountId: "qx-123",
                currency: "usdt",
                userId: 1,
                assetSymbolUpper: "USDT",
                backfilledProviderAddresses: backfilled,
            });

            expect(result).toContainEqual(
                expect.objectContaining({
                    id: 1,
                    address: "0xBACKFILL",
                }),
            );
        });
    });
});
