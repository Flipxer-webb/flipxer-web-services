import { Test, TestingModule } from "@nestjs/testing";
import { NetworkTypes, CryptoWalletStatus } from "@prisma/client";

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class { readonly __stub = true },
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
    normalizeNetworkInput: jest.fn().mockImplementation((input?: string | null) => {
        if (!input) return null;
        const lower = input.toLowerCase();
        if (lower.includes("erc20") || lower === "ethereum") return NetworkTypes.erc20;
        if (lower.includes("trc20") || lower === "tron") return NetworkTypes.trc20;
        if (lower === "btc" || lower === "bitcoin") return NetworkTypes.btc;
        if (lower === "sol" || lower === "solana") return NetworkTypes.solana;
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
            prisma.user.findUnique.mockResolvedValue({ cryptoSubAccountId: "qx-123" });
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
                    where: { userId_assetCurrency: { userId: 1, assetCurrency: "ETH" } },
                    data: expect.objectContaining({ depositAddress: "0xABC" }),
                }),
            );
        });

        it("should return early if user has no crypto sub-account", async () => {
            prisma.user.findUnique.mockResolvedValue({ cryptoSubAccountId: null });

            await service.syncWallet(1, "ETH");

            expect(mockQuidax.getUserWallet).not.toHaveBeenCalled();
        });

        it("should not throw on sync failure", async () => {
            prisma.user.findUnique.mockResolvedValue({ cryptoSubAccountId: "qx-123" });
            mockQuidax.getUserWallet.mockRejectedValue(new Error("Network error"));

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
            prisma.cryptoWalletAddress.findMany.mockResolvedValue(wallets);

            const result = await service.getWalletAddresses(1, { asset: "usdt" } as any);

            expect(result.data).toHaveLength(2);
            expect(prisma.cryptoWalletAddress.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { userId: 1, assetSymbol: "USDT" },
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
                service.initiateWalletAddressCreation(1, { asset: "btc" } as any),
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
    });
});
