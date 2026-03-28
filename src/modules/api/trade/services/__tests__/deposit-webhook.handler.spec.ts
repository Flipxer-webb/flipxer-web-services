/**
 * DepositWebhookHandler Integration Tests
 * 
 * Tests the deposit webhook processing logic including:
 * - New deposit creation
 * - Existing order updates
 * - Wallet balance updates
 * - Notification sending
 */

import { Test, TestingModule } from '@nestjs/testing';

// Break circular dependency: auth/guard → @/modules/api/user → auth/index → auth/controllers → @User()
jest.mock("@/modules/api/user", () => {
    class AccountDeletedException extends Error { constructor() { super("Account deleted"); } }
    class UserNotFoundException extends Error { constructor() { super("User not found"); } }
    return {
        User: () => () => {},
        ClientData: () => () => {},
        UserModule: class {},
        AccountDeletedException,
        UserNotFoundException,
        __esModule: true,
    };
});

import { DepositWebhookHandler } from '../webhook-handlers/deposit-webhook.handler';
import { PrismaService } from '@/modules/core/prisma/services';
import { QuidaxService } from '@/modules/factory/trading/providers/quidax/services';
import { NotificationEvent } from '../../../notification/events/notification.event';
import { NotificationMessageService } from '@/modules/core/messages/services/notification.service';
import { WsGateway } from '../../gateway/v1';
import { TradeHelpersService } from '../trade-helpers.service';
import { WalletAddressService } from '../wallet-address.service';
import { DistributedLockService } from '@/modules/core/redisCache/services/distributed-lock.service';
import { SlackWebhookService } from '@/modules/api/operations/services/slack-webhook.service';
import { LedgerService } from '../ledger/ledger.service';
import { DepositReviewService } from '../ledger/deposit-review.service';
import { TransactionMonitorService } from '../ledger/transaction-monitor.service';
import { NotificationDispatcher } from '../../../notification/services/notification-dispatcher.service';
import { TradingInjectionToken } from '@/modules/factory/trading/types';
import { OrderStatus, OrderCategory } from '@prisma/client';
import { createMockPrismaService, mockDataFactories, MockPrismaClient } from '@/test/mocks';
import { DepositTransaction } from '../../interfaces/trade';

describe('DepositWebhookHandler', () => {
  let handler: DepositWebhookHandler;
  let prisma: MockPrismaClient;
  let quidaxService: { getSingleMarketTicker: jest.Mock; getInstantOrderDetail: jest.Mock };
  let lockService: { withLock: jest.Mock };

  const mockUser = mockDataFactories.user();
  const mockTicker = mockDataFactories.ticker();

  /** Build a valid DepositTransaction (flat shape, matching the interface) */
  function makeDeposit(overrides: Partial<DepositTransaction> = {}): DepositTransaction {
    return {
      status: OrderStatus.accepted,
      txid: 'blockchain-tx-123',
      referenceId: 'ref-123',
      type: 'deposit',
      fee: '0.0001',
      amount: '0.1',
      recipient: 'recipient-addr',
      payment_address: 'sender-addr',
      payment_address_id: 'pa-123',
      network: 'trc20',
      quidaxUserId: 'quidax-123',
      currency: 'btc',
      reason: '',
      created_at: new Date().toISOString(),
      done_at: new Date().toISOString(),
      ...overrides,
    };
  }

  beforeEach(async () => {
    prisma = createMockPrismaService();

    const mockQuidaxService = {
      getSingleMarketTicker: jest.fn(),
      getInstantOrderDetail: jest.fn(),
    };

    const mockLockService = {
      withLock: jest.fn().mockImplementation(async (_key: string, fn: () => Promise<any>) => fn()),
    };

    const mockWsGateway = {
      sendUserNotifications: jest.fn(),
      notifyTransactionUpdate: jest.fn(),
      notifyWalletUpdate: jest.fn(),
      notifyUser: jest.fn(),
    };

    const mockNotificationEvent = {
      sendPushNotification: jest.fn(),
      emit: jest.fn(),
    };

    const mockNotificationMessageService = {
      getDepositMessage: jest.fn().mockReturnValue({
        title: 'Deposit Received',
        body: 'Your deposit has been received',
      }),
      receiveTransaction: jest.fn().mockReturnValue('You received crypto'),
    };

    const mockWalletAddressService = {
      getUserWalletAddress: jest.fn(),
      syncWallet: jest.fn(),
    };

    const mockSlackWebhookService = {
      sendWebhookFailureAlert: jest.fn(),
    };

    const mockLedgerService = {
      recordDeposit: jest.fn(),
      pairedCreditInTransaction: jest.fn().mockResolvedValue({ success: true }),
    };

    const mockDepositReviewService = {
      reviewDeposit: jest.fn(),
      shouldFlagForReview: jest.fn().mockReturnValue(false),
      checkAndQueueIfNeeded: jest.fn().mockResolvedValue({ queued: false }),
    };

    const mockTransactionMonitor = {
      recordTransaction: jest.fn(),
    };

    const mockNotificationDispatcher = {
      notify: jest.fn(),
      dispatch: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DepositWebhookHandler,
        { provide: PrismaService, useValue: prisma },
        { provide: TradingInjectionToken.QUIDAX, useValue: mockQuidaxService },
        { provide: WsGateway, useValue: mockWsGateway },
        { provide: NotificationEvent, useValue: mockNotificationEvent },
        { provide: NotificationMessageService, useValue: mockNotificationMessageService },
        { provide: DistributedLockService, useValue: mockLockService },
        { provide: WalletAddressService, useValue: mockWalletAddressService },
        { provide: SlackWebhookService, useValue: mockSlackWebhookService },
        { provide: TransactionMonitorService, useValue: mockTransactionMonitor },
        { provide: LedgerService, useValue: mockLedgerService },
        { provide: NotificationDispatcher, useValue: mockNotificationDispatcher },
        { provide: DepositReviewService, useValue: mockDepositReviewService },
      ],
    }).compile();

    handler = module.get<DepositWebhookHandler>(DepositWebhookHandler);
    quidaxService = module.get(TradingInjectionToken.QUIDAX);
    lockService = module.get(DistributedLockService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('handle', () => {
    it('should use distributed lock with the referenceId', async () => {
      const deposit = makeDeposit();
      prisma.user.findUnique.mockResolvedValue(mockUser);
      prisma.order.findUnique.mockResolvedValue(null);
      prisma.cryptoWalletAddress.findUnique.mockResolvedValue(null);
      prisma.order.create.mockResolvedValue(
        mockDataFactories.order({ orderCategory: OrderCategory.RECEIVE, status: OrderStatus.completed })
      );
      prisma.assetWallet.findUnique.mockResolvedValue(mockDataFactories.assetWallet({ balance: '0' }));
      prisma.notification.create.mockResolvedValue(mockDataFactories.notification());
      prisma.notification.findMany.mockResolvedValue([]);
      quidaxService.getSingleMarketTicker.mockResolvedValue({
        status: 'success', message: 'Successful',
        data: { at: Date.now(), ticker: mockTicker },
      });

      await handler.handle(deposit);

      expect(lockService.withLock).toHaveBeenCalledWith(
        `deposit:${deposit.referenceId}`,
        expect.any(Function),
        expect.any(Object),
      );
    });

    it('should look up user by quidaxUserId', async () => {
      const deposit = makeDeposit();
      prisma.user.findUnique.mockResolvedValue(null);

      await handler.handle(deposit);

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { cryptoSubAccountId: 'quidax-123' },
      });
    });

    it('should return early when user not found', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      const result = await handler.handle(makeDeposit());

      expect(result).toBeDefined();
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it('should create a new order when none exists', async () => {
      prisma.user.findUnique.mockResolvedValue(mockUser);
      prisma.order.findUnique.mockResolvedValue(null);
      prisma.cryptoWalletAddress.findUnique.mockResolvedValue(null);
      prisma.order.create.mockResolvedValue(
        mockDataFactories.order({ orderCategory: OrderCategory.RECEIVE, status: OrderStatus.completed })
      );
      prisma.assetWallet.findUnique.mockResolvedValue(mockDataFactories.assetWallet({ balance: '0' }));
      prisma.notification.create.mockResolvedValue(mockDataFactories.notification());
      prisma.notification.findMany.mockResolvedValue([]);
      quidaxService.getSingleMarketTicker.mockResolvedValue({
        status: 'success', message: 'Successful',
        data: { at: Date.now(), ticker: mockTicker },
      });

      await handler.handle(makeDeposit());

      expect(prisma.order.create).toHaveBeenCalled();
    });

    it('should handle deposit.pending status', async () => {
      const pending = makeDeposit({ status: OrderStatus.pending });
      prisma.user.findUnique.mockResolvedValue(mockUser);
      prisma.order.findUnique.mockResolvedValue(null);
      prisma.cryptoWalletAddress.findUnique.mockResolvedValue(null);
      prisma.order.create.mockResolvedValue(
        mockDataFactories.order({ status: OrderStatus.pending })
      );
      prisma.assetWallet.findUnique.mockResolvedValue(mockDataFactories.assetWallet({ balance: '0' }));
      quidaxService.getSingleMarketTicker.mockResolvedValue({
        status: 'success', message: 'Successful',
        data: { at: Date.now(), ticker: mockTicker },
      });

      await handler.handle(pending);

      expect(prisma.order.create).toHaveBeenCalled();
    });
  });
});
