/**
 * Prisma Mock Utilities
 * 
 * Provides type-safe mocking utilities for Prisma in tests.
 * This resolves the "mockResolvedValue does not exist" TypeScript errors.
 */

import { PrismaClient } from '@prisma/client';

/**
 * Type for creating a deeply mocked Prisma client
 */
export type MockPrismaClient = {
  [K in keyof PrismaClient]: K extends `$${string}`
    ? PrismaClient[K]
    : {
        [M in keyof PrismaClient[K]]: jest.Mock;
      };
};

/**
 * Creates a mock Prisma service with all methods as Jest mocks.
 * 
 * Usage:
 * ```typescript
 * const mockPrisma = createMockPrismaService();
 * mockPrisma.user.findUnique.mockResolvedValue({ id: 1, email: 'test@example.com' });
 * ```
 */
export function createMockPrismaService(): MockPrismaClient {
  return {
    // User model
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
      upsert: jest.fn(),
    },
    // Order model
    order: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
      upsert: jest.fn(),
      updateMany: jest.fn(),
    },
    // AssetWallet model
    assetWallet: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
      upsert: jest.fn(),
    },
    // CryptoWalletAddress model
    cryptoWalletAddress: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
    // CryptoRate model
    cryptoRate: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    // TransactionFee model
    transactionFee: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    // Notification model
    notification: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
      updateMany: jest.fn(),
    },
    // Transaction model (different from order)
    transaction: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
    // Bank model
    bank: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    // BankAccount model
    bankAccount: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    // Session model
    session: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
    // Prisma client methods
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $transaction: jest.fn((callback) => callback({
      user: { findUnique: jest.fn(), update: jest.fn() },
      order: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
      assetWallet: { findUnique: jest.fn(), update: jest.fn() },
      notification: { create: jest.fn() },
    })),
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
  } as unknown as MockPrismaClient;
}

/**
 * Helper to reset all mocks in a mock Prisma service
 */
export function resetMockPrismaService(mockPrisma: MockPrismaClient): void {
  Object.values(mockPrisma).forEach((model) => {
    if (typeof model === 'object' && model !== null) {
      Object.values(model).forEach((method) => {
        if (typeof method === 'function' && 'mockReset' in method) {
          (method as jest.Mock).mockReset();
        }
      });
    }
  });
}

/**
 * Common mock data factories for tests
 */
export const mockDataFactories = {
  user: (overrides = {}) => ({
    id: 1,
    email: 'test@example.com',
    firstName: 'Test',
    lastName: 'User',
    cryptoSubAccountId: 'quidax-123',
    kycStatus: 'verified',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }),

  order: (overrides = {}) => ({
    id: 1,
    transactionId: 'TXN-123',
    providerOrderId: 'ref-123',
    orderReference: 'order-ref-123',
    status: 'pending',
    streamlinedStatus: 'pending',
    orderCategory: 'RECEIVE',
    amount: 0.1,
    currency: 'BTC',
    fromAmount: 0.1,
    fromCurrency: 'BTC',
    toAmount: 100000,
    toCurrency: 'NGN',
    userId: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }),

  assetWallet: (overrides = {}) => ({
    id: 1,
    userId: 1,
    currency: 'BTC',
    balance: '0.5',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }),

  cryptoWalletAddress: (overrides = {}) => ({
    id: 1,
    userId: 1,
    currency: 'BTC',
    address: 'bc1q...',
    network: 'bitcoin',
    createdAt: new Date(),
    ...overrides,
  }),

  notification: (overrides = {}) => ({
    id: 1,
    userId: 1,
    title: 'Test Notification',
    body: 'Test body',
    type: 'info',
    read: false,
    createdAt: new Date(),
    ...overrides,
  }),

  ticker: (overrides = {}) => ({
    buy: '1500000',
    sell: '1480000',
    low: '1450000',
    high: '1550000',
    open: '1500000',
    last: '1510000',
    vol: '100',
    ...overrides,
  }),
};
