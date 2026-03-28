import { Test, TestingModule } from "@nestjs/testing";

// Break circular dependency: auth/guard → @/modules/api/user → auth/index → auth/controllers → @User()
jest.mock("@/modules/api/user", () => {
    class AccountDeletedException extends Error { constructor() { super("Account deleted"); } }
    class UserNotFoundException extends Error { constructor() { super("User not found"); } }
    return {
        User: () => () => {},
        ClientData: () => () => {},
        UserModule: class { readonly __stub = true },
        AccountDeletedException,
        UserNotFoundException,
        __esModule: true,
    };
});

import { BuyOrderService } from "../buy-order.service";
import { PrismaService } from "@/modules/core/prisma/services";
import { BankInjectionToken } from "@/modules/factory/bank/types";
import { WalletAddressService } from "../wallet-address.service";
import { WsGateway } from "../../gateway/v1";
import { TradeHelpersService } from "../trade-helpers.service";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { LedgerService } from "../ledger/ledger.service";
import { RateService } from "../rate.service";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import { DistributedLockService } from "@/modules/core/redisCache/services/distributed-lock.service";
import { IncompleteAccountSetupException } from "../../errors";

describe("BuyOrderService", () => {
    let service: BuyOrderService;
    let prismaService: any;

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
            payment: {
                findUnique: jest.fn(),
                create: jest.fn(),
            },
        };

        const mockWalletAddressService = {
            syncWallet: jest.fn().mockResolvedValue(undefined),
        };

        const mockWsGateway = {
            notifyTransactionUpdate: jest.fn(),
            notifyWalletUpdate: jest.fn(),
        };

        const mockRateService = {
            getAssetRate: jest.fn().mockResolvedValue({ buyRate: 70000000, sellRate: 69000000 }),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                BuyOrderService,
                { provide: PrismaService, useValue: mockPrismaService },
                { provide: BankInjectionToken.NOMBA, useValue: {} },
                { provide: WalletAddressService, useValue: mockWalletAddressService },
                { provide: WsGateway, useValue: mockWsGateway },
                { provide: TradeHelpersService, useValue: { calculateFee: jest.fn() } },
                { provide: SlackWebhookService, useValue: { sendWebhookFailureAlert: jest.fn() } },
                { provide: LedgerService, useValue: {} },
                { provide: RateService, useValue: mockRateService },
                { provide: NotificationDispatcher, useValue: { notify: jest.fn() } },
                { provide: DistributedLockService, useValue: { withLock: jest.fn((key, fn) => fn()) } },
            ],
        }).compile();

        service = module.get<BuyOrderService>(BuyOrderService);
        prismaService = module.get(PrismaService);
    });

    it("should be defined", () => {
        expect(service).toBeDefined();
    });

    describe("buyCryptoQuoteRequest", () => {
        const quoteDto = {
            asset: "btc",
            amount: 0.01,
        };

        it("should throw IncompleteAccountSetupException when user has no crypto account", async () => {
            const userWithoutAccount = { ...mockUser, cryptoSubAccountId: null } as any;

            await expect(
                service.buyCryptoQuoteRequest(userWithoutAccount, quoteDto)
            ).rejects.toThrow(IncompleteAccountSetupException);
        });

        it("should return quote when all conditions are met", async () => {
            prismaService.assetWallet.findFirst.mockResolvedValue({
                ...mockAssetWallet,
                depositAddress: "bc1q...",
                defaultNetwork: "btc",
            });
            prismaService.cryptoRate.findFirst.mockResolvedValue(mockCryptoRate);
            prismaService.transactionFee.findFirst.mockResolvedValue(mockTransactionFee);

            const result = await service.buyCryptoQuoteRequest(mockUser as any, quoteDto);

            expect(result).toBeDefined();
            expect(result.data).toBeDefined();
        });
    });

    describe("calculateBuyQuote", () => {
        it("should calculate quote correctly", async () => {
            prismaService.assetWallet.findFirst.mockResolvedValue({
                ...mockAssetWallet,
                depositAddress: "bc1q...",
                defaultNetwork: "btc",
            });
            prismaService.cryptoRate.findFirst.mockResolvedValue(mockCryptoRate);
            prismaService.transactionFee.findFirst.mockResolvedValue(mockTransactionFee);

            const quote = await service.calculateBuyQuote(mockUser as any, {
                asset: "BTC",
                amount: 0.1,
            });

            expect(quote).toBeDefined();
            expect(quote.buyRate).toBeDefined();
            expect(quote.cryptoBuyAmount).toBeDefined();
        });
    });

    describe("buyCryptoOrder", () => {
        const orderDto = {
            asset: "btc",
            amount: 0.01,
            buyRate: 70000000,
            charge: 750,
        } as any;

        it("should throw when user has no crypto account", async () => {
            const userWithoutAccount = { ...mockUser, cryptoSubAccountId: null } as any;

            await expect(
                service.buyCryptoOrder(userWithoutAccount, orderDto)
            ).rejects.toThrow();
        });
    });
});
