import { Test, TestingModule } from "@nestjs/testing";
import { BuyOrderService } from "../buy-order.service";
import { PrismaService } from "@/modules/core/prisma/services";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { WalletAddressService } from "../wallet-address.service";
import { WsGateway } from "../../gateway/v1";
import { IncompleteAccountSetupException, AssetNotFoundException } from "../../errors";
import { OrderStatus } from "@prisma/client";

describe("BuyOrderService", () => {
    let service: BuyOrderService;
    let prismaService: jest.Mocked<PrismaService>;
    let quidaxService: jest.Mocked<QuidaxService>;
    let walletAddressService: jest.Mocked<WalletAddressService>;
    let wsGateway: jest.Mocked<WsGateway>;

    const mockUser = {
        id: 1,
        email: "test@example.com",
        cryptoSubAccountId: "quidax-123",
        firstName: "Test",
        lastName: "User",
        userType: "INDIVIDUAL",
    };

    const mockAssetWallet = {
        id: 1,
        userId: 1,
        assetCurrency: "BTC",
        balance: "1.5",
        lockedBalance: "0",
        isActive: true,
    };

    const mockCryptoWalletAddress = {
        id: 1,
        userId: 1,
        assetSymbol: "BTC",
        network: "btc",
        address: "bc1q...",
    };

    const mockCryptoRate = {
        id: 1,
        symbol: "BTC",
        buyRate: "70000000",
        sellRate: "69000000",
    };

    const mockTransactionFee = {
        id: 1,
        category: "BUY",
        asset: "BTC",
        type: "percentage",
        fee: 1.5,
    };

    beforeEach(async () => {
        const mockPrismaService = {
            user: {
                findUnique: jest.fn(),
            },
            assetWallet: {
                findUnique: jest.fn(),
                findFirst: jest.fn(),
            },
            cryptoWalletAddress: {
                findFirst: jest.fn(),
            },
            cryptoRate: {
                findFirst: jest.fn(),
            },
            transactionFee: {
                findFirst: jest.fn(),
            },
            order: {
                create: jest.fn(),
            },
        };

        const mockQuidaxService = {
            getInstantPrice: jest.fn(),
        };

        const mockWalletAddressService = {
            syncWallet: jest.fn().mockResolvedValue(undefined),
        };

        const mockWsGateway = {
            notifyTransactionUpdate: jest.fn(),
            notifyWalletUpdate: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                BuyOrderService,
                { provide: PrismaService, useValue: mockPrismaService },
                { provide: TradingInjectionToken.QUIDAX, useValue: mockQuidaxService },
                { provide: WalletAddressService, useValue: mockWalletAddressService },
                { provide: WsGateway, useValue: mockWsGateway },
            ],
        }).compile();

        service = module.get<BuyOrderService>(BuyOrderService);
        prismaService = module.get(PrismaService);
        quidaxService = module.get(TradingInjectionToken.QUIDAX);
        walletAddressService = module.get(WalletAddressService);
        wsGateway = module.get(WsGateway);
    });

    it("should be defined", () => {
        expect(service).toBeDefined();
    });

    describe("buyCryptoQuoteRequest", () => {
        const quoteDto = {
            asset: "btc",
            amountInFiat: 100000,
        };

        it("should throw IncompleteAccountSetupException when user has no crypto account", async () => {
            prismaService.user.findUnique.mockResolvedValue({
                ...mockUser,
                cryptoSubAccountId: null,
            });

            await expect(
                service.buyCryptoQuoteRequest(1, quoteDto)
            ).rejects.toThrow(IncompleteAccountSetupException);
        });

        it("should return quote when all conditions are met", async () => {
            prismaService.user.findUnique.mockResolvedValue(mockUser);
            prismaService.assetWallet.findFirst.mockResolvedValue(mockAssetWallet);
            prismaService.cryptoWalletAddress.findFirst.mockResolvedValue(mockCryptoWalletAddress);
            prismaService.cryptoRate.findFirst.mockResolvedValue(mockCryptoRate);
            prismaService.transactionFee.findFirst.mockResolvedValue(mockTransactionFee);

            const result = await service.buyCryptoQuoteRequest(1, quoteDto);

            expect(result).toBeDefined();
            expect(result.data).toHaveProperty("quote");
        });
    });

    describe("calculateBuyQuote", () => {
        it("should calculate quote correctly", async () => {
            const rate = 70000000; // 70M NGN per BTC
            const amountInFiat = 7000000; // 7M NGN
            const feePercentage = 1.5;

            prismaService.transactionFee.findFirst.mockResolvedValue({
                ...mockTransactionFee,
                fee: feePercentage,
            });

            const quote = await service.calculateBuyQuote({
                asset: "BTC",
                amountInFiat,
                rate,
                userId: 1,
            });

            expect(quote).toBeDefined();
            expect(quote.amountInCrypto).toBeDefined();
            expect(quote.fee).toBeDefined();
            expect(quote.rate).toBe(rate);
        });
    });

    describe("buyCryptoOrder", () => {
        const orderDto = {
            asset: "btc",
            amountInFiat: 100000,
            paymentMethod: "bank_transfer",
        };

        it("should throw when user has no crypto account", async () => {
            prismaService.user.findUnique.mockResolvedValue({
                ...mockUser,
                cryptoSubAccountId: null,
            });

            await expect(
                service.buyCryptoOrder(1, orderDto)
            ).rejects.toThrow(IncompleteAccountSetupException);
        });

        it("should throw when asset wallet not found", async () => {
            prismaService.user.findUnique.mockResolvedValue(mockUser);
            prismaService.assetWallet.findFirst.mockResolvedValue(null);

            await expect(
                service.buyCryptoOrder(1, orderDto)
            ).rejects.toThrow(AssetNotFoundException);
        });

        it("should create order when all conditions are met", async () => {
            prismaService.user.findUnique.mockResolvedValue(mockUser);
            prismaService.assetWallet.findFirst.mockResolvedValue(mockAssetWallet);
            prismaService.cryptoWalletAddress.findFirst.mockResolvedValue(mockCryptoWalletAddress);
            prismaService.cryptoRate.findFirst.mockResolvedValue(mockCryptoRate);
            prismaService.transactionFee.findFirst.mockResolvedValue(mockTransactionFee);
            prismaService.order.create.mockResolvedValue({
                id: 1,
                transactionId: "TXN-123",
                status: OrderStatus.pending,
            });

            const result = await service.buyCryptoOrder(1, orderDto);

            expect(result).toBeDefined();
            expect(prismaService.order.create).toHaveBeenCalled();
            expect(wsGateway.notifyTransactionUpdate).toHaveBeenCalled();
        });
    });
});
