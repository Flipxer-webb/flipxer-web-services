import { Test, TestingModule } from "@nestjs/testing";
import { WebhookHandlerService } from "../webhook-handler.service";
import { PrismaService } from "@/modules/core/prisma/services";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import { FincraBank } from "@/modules/factory/bank/providers/fincra.provider";
import { NotificationEvent } from "../../../notification/events/notification.event";
import { NotificationMessageService } from "@/modules/core/messages/services/notification.service";
import { WsGateway } from "../../gateway/v1";
import { DistributedLockService } from "@/modules/core/redisCache/services/distributed-lock.service";
import { TradeHelpersService } from "../trade-helpers.service";
import { WalletAddressService } from "../wallet-address.service";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { BankInjectionToken } from "@/modules/factory/bank/types";
import { OrderStatus, OrderCategory } from "@prisma/client";
import { TransactionNotFoundException, TransactionCompletedException } from "../../errors";

describe("WebhookHandlerService", () => {
    let service: WebhookHandlerService;
    let prismaService: jest.Mocked<PrismaService>;
    let quidaxService: jest.Mocked<QuidaxService>;
    let lockService: jest.Mocked<DistributedLockService>;
    let walletAddressService: jest.Mocked<WalletAddressService>;
    let wsGateway: jest.Mocked<WsGateway>;
    let notificationEvent: jest.Mocked<NotificationEvent>;

    const mockUser = {
        id: 1,
        email: "test@example.com",
        cryptoSubAccountId: "quidax-123",
        firstName: "Test",
        lastName: "User",
    };

    const mockOrder = {
        id: 1,
        transactionId: "TXN-123",
        providerOrderId: "ref-123",
        orderReference: "order-ref-123",
        status: OrderStatus.pending,
        streamlinedStatus: "pending",
        orderCategory: OrderCategory.RECEIVE,
        amount: 0.1,
        currency: "BTC",
        fromAmount: 0.1,
        fromCurrency: "BTC",
        toAmount: 100,
        toCurrency: "USDT",
        user: mockUser,
        userId: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
    };

    beforeEach(async () => {
        const mockPrismaService = {
            user: {
                findUnique: jest.fn(),
            },
            order: {
                findUnique: jest.fn(),
                create: jest.fn(),
                update: jest.fn(),
            },
            cryptoWalletAddress: {
                findUnique: jest.fn(),
            },
            assetWallet: {
                findUnique: jest.fn(),
                update: jest.fn(),
            },
            notification: {
                create: jest.fn(),
                findMany: jest.fn(),
            },
        };

        const mockQuidaxService = {
            getSingleMarketTicker: jest.fn(),
        };

        const mockFincraService = {
            initializeTransfer: jest.fn(),
        };

        const mockNotificationEvent = {
            emit: jest.fn(),
        };

        const mockNotificationMessageService = {
            receiveTransaction: jest.fn().mockReturnValue("You received crypto"),
            swapTransactionSuccess: jest.fn().mockReturnValue("Swap completed"),
            sendTransactionSuccess: jest.fn().mockReturnValue("Send completed"),
        };

        const mockWsGateway = {
            notifyTransactionUpdate: jest.fn(),
            notifyWalletUpdate: jest.fn(),
            notifyUser: jest.fn(),
        };

        const mockLockService = {
            withLock: jest.fn().mockImplementation(async (key, callback) => {
                return await callback();
            }),
        };

        const mockTradeHelpersService = {
            safeJsonStringify: jest.fn().mockImplementation(JSON.stringify),
        };

        const mockWalletAddressService = {
            syncWallet: jest.fn().mockResolvedValue(undefined),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                WebhookHandlerService,
                { provide: PrismaService, useValue: mockPrismaService },
                { provide: TradingInjectionToken.QUIDAX, useValue: mockQuidaxService },
                { provide: BankInjectionToken.FINCRA, useValue: mockFincraService },
                { provide: NotificationEvent, useValue: mockNotificationEvent },
                { provide: NotificationMessageService, useValue: mockNotificationMessageService },
                { provide: WsGateway, useValue: mockWsGateway },
                { provide: DistributedLockService, useValue: mockLockService },
                { provide: TradeHelpersService, useValue: mockTradeHelpersService },
                { provide: WalletAddressService, useValue: mockWalletAddressService },
            ],
        }).compile();

        service = module.get<WebhookHandlerService>(WebhookHandlerService);
        prismaService = module.get(PrismaService);
        quidaxService = module.get(TradingInjectionToken.QUIDAX);
        lockService = module.get(DistributedLockService);
        walletAddressService = module.get(WalletAddressService);
        wsGateway = module.get(WsGateway);
        notificationEvent = module.get(NotificationEvent);
    });

    it("should be defined", () => {
        expect(service).toBeDefined();
    });

    describe("depositHandler", () => {
        const depositOptions = {
            quidaxUserId: "quidax-123",
            referenceId: "dep-ref-123",
            payment_address_id: "addr-123",
            network: "trc20",
            currency: "usdt",
            amount: "100",
            fee: "0.1",
            status: OrderStatus.accepted,
            txid: "blockchain-txid",
            recipient: "recipient-address",
            payment_address: "sender-address",
            type: "deposit",
            reason: null,
            created_at: new Date().toISOString(),
            done_at: new Date().toISOString(),
        };

        it("should create new deposit transaction when none exists", async () => {
            prismaService.user.findUnique.mockResolvedValue(mockUser);
            prismaService.order.findUnique.mockResolvedValue(null);
            prismaService.cryptoWalletAddress.findUnique.mockResolvedValue(null);
            prismaService.order.create.mockResolvedValue({ ...mockOrder, orderCategory: OrderCategory.RECEIVE });
            prismaService.assetWallet.findUnique.mockResolvedValue({ id: 1, balance: "0" });
            prismaService.notification.create.mockResolvedValue({ id: 1 });
            prismaService.notification.findMany.mockResolvedValue([]);
            quidaxService.getSingleMarketTicker.mockResolvedValue({
                data: { ticker: { buy: "1500000" } },
            });

            const result = await service.depositHandler(depositOptions);

            expect(result).toBeDefined();
            expect(prismaService.order.create).toHaveBeenCalled();
            expect(wsGateway.notifyTransactionUpdate).toHaveBeenCalled();
        });

        it("should update existing deposit transaction", async () => {
            prismaService.user.findUnique.mockResolvedValue(mockUser);
            prismaService.order.findUnique.mockResolvedValue({
                ...mockOrder,
                status: OrderStatus.pending,
            });
            prismaService.order.update.mockResolvedValue({
                ...mockOrder,
                status: OrderStatus.accepted,
            });
            prismaService.assetWallet.findUnique.mockResolvedValue({ id: 1, balance: "0" });
            prismaService.notification.create.mockResolvedValue({ id: 1 });
            prismaService.notification.findMany.mockResolvedValue([]);

            await service.depositHandler(depositOptions);

            expect(prismaService.order.update).toHaveBeenCalled();
            expect(wsGateway.notifyTransactionUpdate).toHaveBeenCalled();
        });

        it("should return early when user not found", async () => {
            prismaService.user.findUnique.mockResolvedValue(null);

            const result = await service.depositHandler(depositOptions);

            expect(result.data.message).toContain("User not found");
            expect(prismaService.order.create).not.toHaveBeenCalled();
        });

        it("should use distributed lock", async () => {
            prismaService.user.findUnique.mockResolvedValue(mockUser);
            prismaService.order.findUnique.mockResolvedValue(null);
            prismaService.order.create.mockResolvedValue(mockOrder);
            prismaService.assetWallet.findUnique.mockResolvedValue(null);
            quidaxService.getSingleMarketTicker.mockResolvedValue({
                data: { ticker: { buy: "1500000" } },
            });

            await service.depositHandler(depositOptions);

            expect(lockService.withLock).toHaveBeenCalledWith(
                `deposit:${depositOptions.referenceId}`,
                expect.any(Function),
                expect.any(Object)
            );
        });
    });

    describe("swapTransactionHandler", () => {
        const swapOptions = {
            orderId: "swap-123",
            status: OrderStatus.completed,
        };

        it("should update swap transaction status", async () => {
            prismaService.order.findUnique.mockResolvedValue({
                ...mockOrder,
                orderCategory: OrderCategory.SWAP,
                status: OrderStatus.pending,
            });
            prismaService.order.update.mockResolvedValue({
                ...mockOrder,
                status: OrderStatus.completed,
            });
            prismaService.notification.create.mockResolvedValue({ id: 1 });
            prismaService.notification.findMany.mockResolvedValue([]);

            await service.swapTransactionHandler(swapOptions);

            expect(prismaService.order.update).toHaveBeenCalled();
            expect(walletAddressService.syncWallet).toHaveBeenCalledTimes(2); // Both currencies
            expect(wsGateway.notifyWalletUpdate).toHaveBeenCalled();
        });

        it("should throw when transaction not found", async () => {
            prismaService.order.findUnique.mockResolvedValue(null);

            await expect(
                service.swapTransactionHandler(swapOptions)
            ).rejects.toThrow(TransactionNotFoundException);
        });

        it("should throw when transaction already completed", async () => {
            prismaService.order.findUnique.mockResolvedValue({
                ...mockOrder,
                status: OrderStatus.completed,
            });

            await expect(
                service.swapTransactionHandler(swapOptions)
            ).rejects.toThrow(TransactionCompletedException);
        });

        it("should skip if status unchanged", async () => {
            prismaService.order.findUnique.mockResolvedValue({
                ...mockOrder,
                status: OrderStatus.completed,
                user: mockUser,
            });

            // This should not throw because we check status match before completed check
            prismaService.order.findUnique.mockResolvedValue({
                ...mockOrder,
                status: swapOptions.status,
                user: mockUser,
            });

            await service.swapTransactionHandler(swapOptions);

            expect(prismaService.order.update).not.toHaveBeenCalled();
        });
    });

    describe("withdrawerTransactionHandler", () => {
        const withdrawOptions = {
            orderReference: "withdraw-ref-123",
            status: OrderStatus.done,
        };

        it("should update withdrawal transaction status", async () => {
            prismaService.order.findUnique.mockResolvedValue({
                ...mockOrder,
                orderCategory: OrderCategory.SEND,
                status: OrderStatus.pending,
            });
            prismaService.order.update.mockResolvedValue({
                ...mockOrder,
                status: OrderStatus.done,
            });
            prismaService.notification.create.mockResolvedValue({ id: 1 });
            prismaService.notification.findMany.mockResolvedValue([]);

            await service.withdrawerTransactionHandler(withdrawOptions);

            expect(prismaService.order.update).toHaveBeenCalled();
            expect(walletAddressService.syncWallet).toHaveBeenCalled();
            expect(wsGateway.notifyWalletUpdate).toHaveBeenCalled();
        });

        it("should throw when transaction not found", async () => {
            prismaService.order.findUnique.mockResolvedValue(null);

            await expect(
                service.withdrawerTransactionHandler(withdrawOptions)
            ).rejects.toThrow(TransactionNotFoundException);
        });

        it("should handle failed withdrawals", async () => {
            const failedOptions = { ...withdrawOptions, status: OrderStatus.failed };
            
            prismaService.order.findUnique.mockResolvedValue({
                ...mockOrder,
                orderCategory: OrderCategory.SEND,
                status: OrderStatus.pending,
            });
            prismaService.order.update.mockResolvedValue({
                ...mockOrder,
                status: OrderStatus.failed,
            });
            prismaService.notification.create.mockResolvedValue({ id: 1 });
            prismaService.notification.findMany.mockResolvedValue([]);

            await service.withdrawerTransactionHandler(failedOptions);

            expect(prismaService.notification.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        title: "Send transaction failed",
                    }),
                })
            );
        });
    });
});
