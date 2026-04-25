jest.mock("../../../auth/guard", () => ({
    AuthGuard: class { isStub() { return true; } },
    CountryBlockGuard: class { isStub() { return true; } },
    EnabledAccountGuard: class { isStub() { return true; } },
    FincraWebhookGuard: class { isStub() { return true; } },
    NombaWebhookGuard: class { isStub() { return true; } },
    QuidaxWebhookGuard: class { isStub() { return true; } },
    SocketAuthGuard: class { isStub() { return true; } },
    TransactionAmountGuard: class { isStub() { return true; } },
    TwoFactorGuard: class { isStub() { return true; } },
    __esModule: true,
}));

/**
 * NormalizedPaymentWebhookController Tests
 *
 * Covers:
 * - Normalized payload reference extraction for VA-credit, checkout, and transfer events
 * - Normalized event routing for provider webhook source events
 * - handleIncomingPayment: fulfillment routing, underpayment guard, missing reference
 * - handleWebhook: normalized event delegation after guard verification
 */

import { Test, TestingModule } from '@nestjs/testing';

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

import { NombaWebhookController } from '../nomba-webhook.controller';
import { PrismaService } from '@/modules/core/prisma/services';
import { BuyOrderService } from '../../../trade/services/buy-order.service';
import { SlackWebhookService } from '@/modules/api/operations/services/slack-webhook.service';
import { PaymentWebhookAdapterService } from '@/modules/factory/bank/services/payment-webhook-adapter.service';
import {
    TransactionStatus,
} from '@prisma/client';
import { SellPayoutReconciliationService } from '../../../trade/services/sell-payout-reconciliation.service';

// ─── mock factories ─────────────────────────────────────────

function mockPrisma() {
    const prisma = {
        payment: {
            findFirst: jest.fn(),
            findUnique: jest.fn(),
            findMany: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn(),
        },
        order: {
            findUnique: jest.fn(),
            update: jest.fn(),
        },
        webhookLog: {
            upsert: jest.fn(),
        },
        $transaction: jest.fn(),
    };

    prisma.$transaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) => (
        callback({
            payment: prisma.payment,
            order: prisma.order,
            webhookLog: prisma.webhookLog,
        })
    ));

    return prisma;
}

function mockBuyOrderService() {
    return { fulfillBuyOrder: jest.fn() };
}

function mockSlackWebhookService() {
    return { sendWebhookFailureAlert: jest.fn() };
}

function mockSellPayoutReconciliationService() {
    return {
        reconcileSellPayoutState: jest.fn().mockResolvedValue(null),
        executeSellPayoutSideEffects: jest.fn().mockResolvedValue(undefined),
    };
}

// ─── helpers ─────────────────────────────────────────────────

/** Build a minimal VA-credit webhook body (the flow that was broken). */
function vaCredit(accountRef: string, amount = 1000) {
    return {
        event_type: 'virtual_account.credited',
        data: {
            accountRef,
            amount,
            id: 'nomba-txn-001',
        },
    };
}

/** Build a realistic VA payment_success payload (vact_transfer) from Nomba docs. */
function vaPaymentSuccess(aliasAccountReference: string, amount = 1000) {
    return {
        event_type: 'payment_success',
        requestId: '49e11b44-909b-4f83-82b4-9a83aXXXXXX',
        data: {
            merchant: {
                walletId: 'wallet-1',
                walletBalance: 539.4,
                userId: 'merchant-user-1',
            },
            terminal: {},
            transaction: {
                type: 'vact_transfer',
                transactionId: 'API-VACT_TRA-xxx',
                transactionAmount: amount,
                narration: 'Transfer from JOHN GRASS',
                time: '2026-02-06T10:21:56Z',
                aliasAccountReference,
            },
            customer: {
                senderName: 'JOHN GRASS',
                bankName: 'Paycom (Opay)',
                accountNumber: '81689XXX',
            },
        },
    };
}

/** Build a checkout/order webhook body. */
function checkoutSuccess(orderReference: string, amount = 2000) {
    return {
        event_type: 'payment_success',
        data: {
            order: { orderReference, amount },
        },
    };
}

/** Build a transfer-completed webhook body. */
function transferCompleted(merchantTxRef: string, amount = 500) {
    return {
        event_type: 'transfer.successful',
        data: {
            transaction: { merchantTxRef, transactionAmount: amount, transactionId: 'tid-1' },
        },
    };
}

/** Build a transfer-failed webhook body. */
function transferFailed(merchantTxRef: string) {
    return {
        event_type: 'transfer.failed',
        data: {
            transaction: { merchantTxRef, transactionId: 'tid-2' },
        },
    };
}

/** Build a payment_success webhook with transaction.accountRef (the shape that was failing in prod). */
function paymentSuccessViaTransaction(accountRef: string, amount = 1500) {
    return {
        event_type: 'payment_success',
        data: {
            merchant: { id: 'merchant-1' },
            terminal: { id: 'terminal-1' },
            transaction: {
                accountRef,
                transactionAmount: amount,
                transactionId: 'txn-ps-001',
            },
            customer: { id: 'cust-1' },
        },
    };
}

// ─── test suite ──────────────────────────────────────────────

describe('NormalizedPaymentWebhookController', () => {
    let controller: NombaWebhookController;
    let prisma: ReturnType<typeof mockPrisma>;
    let buyOrderService: ReturnType<typeof mockBuyOrderService>;
    let slackService: ReturnType<typeof mockSlackWebhookService>;
    let sellPayoutReconciliationService: ReturnType<typeof mockSellPayoutReconciliationService>;

    /** Representative webhook headers passed through after guard verification */
    const sigHeaders = { 'nomba-signature': 'test-sig', 'nomba-timestamp': '1234567890' };

    beforeEach(async () => {
        prisma = mockPrisma();
        buyOrderService = mockBuyOrderService();
        slackService = mockSlackWebhookService();
        sellPayoutReconciliationService = mockSellPayoutReconciliationService();

        const module: TestingModule = await Test.createTestingModule({
            controllers: [NombaWebhookController],
            providers: [
                { provide: PrismaService, useValue: prisma },
                { provide: BuyOrderService, useValue: buyOrderService },
                { provide: SlackWebhookService, useValue: slackService },
                PaymentWebhookAdapterService,
                { provide: SellPayoutReconciliationService, useValue: sellPayoutReconciliationService },
            ],
        }).compile();

        controller = module.get(NombaWebhookController);
    });

    it('should return active status from verify endpoint', () => {
        expect(controller.verifyWebhookUrl()).toEqual({
            status: 'ok',
            message: 'Nomba webhook endpoint active',
        });
    });

    // ── Normalization / Reference Extraction ─────────────────

    describe('normalizePayload — reference extraction', () => {
        it('should extract aliasAccountReference from VA payment_success (vact_transfer)', async () => {
            const ref = 'va-ref-alias-123';
            const payment = { id: 9, orderId: 98, totalAmount: 1000, reference: ref, userId: 7 };
            prisma.payment.findFirst.mockResolvedValue(payment);
            buyOrderService.fulfillBuyOrder.mockResolvedValue(undefined);

            await controller.handleWebhook(vaPaymentSuccess(ref, 1000), sigHeaders);

            expect(buyOrderService.fulfillBuyOrder).toHaveBeenCalledWith(ref);
        });

        it('should extract accountRef from VA-credit webhooks', async () => {
            const ref = 'g156bb83hh82gg4h16b6gb088ha677';
            const payment = { id: 10, orderId: 99, totalAmount: 1000, reference: ref, userId: 7 };
            prisma.payment.findFirst.mockResolvedValue(payment);
            buyOrderService.fulfillBuyOrder.mockResolvedValue(undefined);

            await controller.handleWebhook(vaCredit(ref, 1000), sigHeaders);

            expect(buyOrderService.fulfillBuyOrder).toHaveBeenCalledWith(ref);
        });

        it('should extract orderReference from checkout webhooks', async () => {
            const ref = 'order-ref-abc';
            const payment = { id: 11, orderId: 100, totalAmount: 2000, reference: ref, userId: 8 };
            prisma.payment.findFirst.mockResolvedValue(payment);
            buyOrderService.fulfillBuyOrder.mockResolvedValue(undefined);

            await controller.handleWebhook(checkoutSuccess(ref, 2000), sigHeaders);

            expect(buyOrderService.fulfillBuyOrder).toHaveBeenCalledWith(ref);
        });

        it('should extract merchantTxRef from transfer webhooks', async () => {
            const ref = 'merch-ref-xyz';
            const payment = { id: 50, reference: ref };
            prisma.payment.findFirst.mockResolvedValue(payment);
            prisma.payment.update.mockResolvedValue(payment);

            await controller.handleWebhook(transferCompleted(ref, 500), sigHeaders);

            expect(prisma.payment.findFirst).toHaveBeenCalledWith({ where: { reference: ref } });
            expect(prisma.payment.update).toHaveBeenCalledWith({
                where: { id: 50 },
                data: expect.objectContaining({
                    status: TransactionStatus.SUCCESS,
                    paymentStatus: TransactionStatus.SUCCESS,
                }),
            });
        });

        it('should prefer accountRef over orderReference', async () => {
            const body = {
                event_type: 'payment_success',
                data: {
                    accountRef: 'should-not-use',
                    order: { orderReference: 'preferred-ref', amount: 100 },
                },
            };
            const payment = { id: 12, orderId: 101, totalAmount: 100, reference: 'should-not-use', userId: 9 };
            prisma.payment.findFirst.mockResolvedValue(payment);
            buyOrderService.fulfillBuyOrder.mockResolvedValue(undefined);

            await controller.handleWebhook(body, sigHeaders);

            expect(buyOrderService.fulfillBuyOrder).toHaveBeenCalledWith('should-not-use');
        });

        it('should prefer accountRef over data.reference', async () => {
            const body = {
                event_type: 'virtual_account.credited',
                data: {
                    reference: 'data-ref',
                    accountRef: 'account-ref-fallback',
                    amount: 100,
                },
            };
            const payment = { id: 13, orderId: null, totalAmount: 100, reference: 'account-ref-fallback', userId: 10 };
            prisma.payment.findFirst.mockResolvedValue(payment);

            await controller.handleWebhook(body, sigHeaders);

            // The payment lookup goes through with 'account-ref-fallback', not 'data-ref'
            expect(prisma.payment.findFirst).toHaveBeenCalledWith({ where: { reference: 'account-ref-fallback' } });
        });

        it('should return success when no reference can be extracted from a payment event', async () => {
            const body = {
                event_type: 'virtual_account.credited',
                data: { amount: 500 }, // no reference fields at all
            };

            const result = await controller.handleWebhook(body, sigHeaders);
            expect(result).toEqual({ success: true, message: "Webhook processed" });
        });

        it('should extract transaction.accountRef from payment_success webhooks (prod shape)', async () => {
            const ref = 'va-ref-prod-shape';
            const payment = { id: 50, orderId: 500, totalAmount: 1500, reference: ref, userId: 11 };
            prisma.payment.findFirst.mockResolvedValue(payment);
            buyOrderService.fulfillBuyOrder.mockResolvedValue(undefined);

            await controller.handleWebhook(paymentSuccessViaTransaction(ref, 1500), sigHeaders);

            expect(prisma.payment.findFirst).toHaveBeenCalledWith({ where: { reference: ref } });
            expect(buyOrderService.fulfillBuyOrder).toHaveBeenCalledWith(ref);
        });

        it('should resolve accountRef-only payment_success webhooks via providerAccountReference fallback', async () => {
            const providerAccountRef = 'fallback-va-ref';
            const internalReference = 'local-buy-ref';
            const payment = {
                id: 52,
                orderId: 502,
                totalAmount: 1500,
                reference: internalReference,
                providerAccountReference: providerAccountRef,
                userId: 11,
            };
            prisma.payment.findFirst
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce(payment);
            buyOrderService.fulfillBuyOrder.mockResolvedValue(undefined);

            await controller.handleWebhook(paymentSuccessViaTransaction(providerAccountRef, 1500), sigHeaders);

            expect(prisma.payment.findFirst).toHaveBeenNthCalledWith(1, {
                where: { reference: providerAccountRef },
            });
            expect(prisma.payment.findFirst).toHaveBeenNthCalledWith(2, {
                where: {
                    providerAccountReference: providerAccountRef,
                    paymentMethod: 'NOMBA',
                    type: 'P2P_PAYMENT',
                    orderId: { not: null },
                    status: {
                        in: [
                            TransactionStatus.PENDING,
                            TransactionStatus.APPROVED,
                            TransactionStatus.FAILED,
                        ],
                    },
                    totalAmount: 1500,
                },
                orderBy: { createdAt: 'desc' },
            });
            expect(buyOrderService.fulfillBuyOrder).toHaveBeenCalledWith(internalReference);
        });

        it('should extract transaction.reference when accountRef is absent', async () => {
            const ref = 'txn-ref-fallback';
            const body = {
                event_type: 'payment_success',
                data: {
                    transaction: { reference: ref, transactionAmount: 200, transactionId: 'tid-3' },
                },
            };
            const payment = { id: 51, orderId: null, totalAmount: 200, reference: ref, userId: 12 };
            prisma.payment.findFirst.mockResolvedValue(payment);

            await controller.handleWebhook(body, sigHeaders);

            expect(prisma.payment.findFirst).toHaveBeenCalledWith({ where: { reference: ref } });
        });
    });

    // ── Event Type Mapping ───────────────────────────────────

    describe('normalizePayload — event type mapping', () => {
        it('should map virtual_account.credited to payment_success and fulfill', async () => {
            const ref = 'va-ref-1';
            const payment = { id: 20, orderId: 200, totalAmount: 500, reference: ref, userId: 7 };
            prisma.payment.findFirst.mockResolvedValue(payment);
            buyOrderService.fulfillBuyOrder.mockResolvedValue(undefined);

            await controller.handleWebhook(vaCredit(ref, 500), sigHeaders);

            expect(buyOrderService.fulfillBuyOrder).toHaveBeenCalledWith(ref);
        });

        it('should map transaction.completed to payment_success', async () => {
            const body = {
                event_type: 'transaction.completed',
                data: { accountRef: 'ref-tc', amount: 300 },
            };
            const payment = { id: 21, orderId: 201, totalAmount: 300, reference: 'ref-tc', userId: 7 };
            prisma.payment.findFirst.mockResolvedValue(payment);
            buyOrderService.fulfillBuyOrder.mockResolvedValue(undefined);

            await controller.handleWebhook(body, sigHeaders);

            expect(buyOrderService.fulfillBuyOrder).toHaveBeenCalledWith('ref-tc');
        });

        it('should map transfer.successful to payout_success', async () => {
            const ref = 'payout-ref';
            const payment = { id: 51, reference: ref };
            prisma.payment.findFirst.mockResolvedValue(payment);
            prisma.payment.update.mockResolvedValue(payment);

            await controller.handleWebhook(transferCompleted(ref), sigHeaders);

            expect(prisma.payment.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ status: TransactionStatus.SUCCESS }),
                }),
            );
        });

        it('should map transfer.failed to payment_failed', async () => {
            const ref = 'fail-ref';
            prisma.payment.findMany.mockResolvedValue([]);
            prisma.payment.updateMany.mockResolvedValue({ count: 1 });

            await controller.handleWebhook(transferFailed(ref), sigHeaders);

            expect(prisma.payment.updateMany).toHaveBeenCalledWith({
                where: { reference: ref },
                data: {
                    status: TransactionStatus.FAILED,
                    paymentStatus: TransactionStatus.FAILED,
                },
            });
        });

        it('should handle unknown event type without error', async () => {
            const body = {
                event_type: 'some_unknown_event',
                data: { reference: 'ref-unknown' },
            };

            // Should not throw — just logs a warning and returns
            const result = await controller.handleWebhook(body, sigHeaders);
            expect(result).toEqual({ success: true, message: 'Webhook processed' });
        });
    });

    // ── handleIncomingPayment details ────────────────────────

    describe('handleIncomingPayment — fulfillment flow', () => {
        it('should trigger fulfillBuyOrder when payment has an orderId', async () => {
            const ref = 'buy-ref-1';
            const payment = { id: 30, orderId: 300, totalAmount: 1000, reference: ref, userId: 7 };
            prisma.payment.findFirst.mockResolvedValue(payment);
            prisma.payment.update.mockResolvedValue(payment);
            buyOrderService.fulfillBuyOrder.mockResolvedValue(undefined);

            await controller.handleWebhook(vaCredit(ref, 1000), sigHeaders);

            expect(buyOrderService.fulfillBuyOrder).toHaveBeenCalledWith(ref);
        });

        it('should update payment to SUCCESS when payment has no orderId (generic)', async () => {
            const ref = 'generic-ref';
            const payment = { id: 31, orderId: null, totalAmount: 500, reference: ref, userId: 8 };
            prisma.payment.findFirst.mockResolvedValue(payment);

            await controller.handleWebhook(vaCredit(ref, 500), sigHeaders);

            expect(buyOrderService.fulfillBuyOrder).not.toHaveBeenCalled();
            expect(prisma.payment.update).toHaveBeenCalledWith({
                where: { id: 31 },
                data: {
                    status: TransactionStatus.SUCCESS,
                    paymentStatus: TransactionStatus.SUCCESS,
                    externalReference: 'nomba-txn-001',
                },
            });
        });

        it('should NOT fulfill and should alert Slack on underpayment', async () => {
            const ref = 'underpay-ref';
            const payment = { id: 32, orderId: 302, totalAmount: 1000, reference: ref, userId: 7 };
            prisma.payment.findFirst.mockResolvedValue(payment);

            // User sent 800 but expected 1000 (below 1% tolerance)
            await controller.handleWebhook(vaCredit(ref, 800), sigHeaders);

            expect(buyOrderService.fulfillBuyOrder).not.toHaveBeenCalled();
            expect(slackService.sendWebhookFailureAlert).toHaveBeenCalledWith(
                'nomba',
                ref,
                expect.stringContaining('Underpayment'),
                expect.objectContaining({
                    orderId: 302,
                    expectedAmount: 1000,
                    receivedAmount: 800,
                }),
            );
        });

        it('should persist sender details from data.customer on underpayment', async () => {
            const ref = 'underpay-customer-ref';
            const payment = { id: 40, orderId: 400, totalAmount: 5000, reference: ref, userId: 8 };
            prisma.payment.findFirst.mockResolvedValue(payment);

            // payload with data.customer (real Nomba shape)
            await controller.handleWebhook(vaPaymentSuccess(ref, 2000), sigHeaders);

            expect(buyOrderService.fulfillBuyOrder).not.toHaveBeenCalled();
            expect(prisma.payment.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 40 },
                    data: expect.objectContaining({
                        receivedAmount: 2000,
                        senderAccountNumber: '81689XXX',
                        senderAccountName: 'JOHN GRASS',
                        senderBankName: 'Paycom (Opay)',
                    }),
                }),
            );
        });

        it('should fulfill when amount is within 1% tolerance of expected', async () => {
            const ref = 'almost-ref';
            const payment = { id: 33, orderId: 303, totalAmount: 1000, reference: ref, userId: 7 };
            prisma.payment.findFirst.mockResolvedValue(payment);
            buyOrderService.fulfillBuyOrder.mockResolvedValue(undefined);

            // 995 is above 99% of 1000 — should pass
            await controller.handleWebhook(vaCredit(ref, 995), sigHeaders);

            expect(buyOrderService.fulfillBuyOrder).toHaveBeenCalledWith(ref);
        });

        it('should store providerReference on buy-order payment before fulfillment', async () => {
            const ref = 'buy-prov-ref';
            const payment = { id: 36, orderId: 360, totalAmount: 1000, reference: ref, userId: 9 };
            prisma.payment.findFirst.mockResolvedValue(payment);
            prisma.payment.update.mockResolvedValue(payment);
            buyOrderService.fulfillBuyOrder.mockResolvedValue(undefined);

            // vaPaymentSuccess includes a transactionId as the provider reference
            await controller.handleWebhook(vaPaymentSuccess(ref, 1000), sigHeaders);

            expect(prisma.payment.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 36 },
                    data: expect.objectContaining({
                        externalReference: expect.any(String),
                    }),
                }),
            );
            expect(buyOrderService.fulfillBuyOrder).toHaveBeenCalledWith(ref);
        });

        it('should resolve provider accountRef to internal payment reference', async () => {
            const providerRef = 'provider-account-ref';
            const internalRef = 'internal-payment-ref';
            const payment = { id: 37, orderId: null, totalAmount: 500, reference: internalRef, userId: 10 };
            prisma.payment.findFirst.mockResolvedValue(payment);

            await controller.handleWebhook(vaCredit(providerRef, 500), sigHeaders);

            // Should use the internal reference (payment.reference), not the provider ref
            expect(prisma.payment.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 37 },
                    data: expect.objectContaining({
                        status: TransactionStatus.SUCCESS,
                    }),
                }),
            );
        });

        it('should warn but not throw when no payment found for reference', async () => {
            const ref = 'orphan-ref';
            prisma.payment.findFirst.mockResolvedValue(null);

            // Should complete without error
            const result = await controller.handleWebhook(vaCredit(ref, 100), sigHeaders);
            expect(result).toEqual({ success: true, message: 'Webhook processed' });
        });
    });

    // ── handleWebhook — entry point guards ───────────────────

    describe('handleWebhook — entry guards', () => {
        it('should return ok for empty/verification body', async () => {
            const result = await controller.handleWebhook({}, sigHeaders);
            expect(result).toEqual({ success: true, message: 'Webhook processed' });
        });

        it('should return ok for null body', async () => {
            const result = await controller.handleWebhook(null, sigHeaders);
            expect(result).toEqual({ success: true, message: 'Webhook processed' });
        });

        it('should accept body with legacy "event" field', async () => {
            const ref = 'legacy-ref';
            const body = {
                event: 'virtual_account.credited',  // legacy field, not event_type
                data: { accountRef: ref, amount: 100 },
            };
            const payment = { id: 40, orderId: 400, totalAmount: 100, reference: ref, userId: 7 };
            prisma.payment.findFirst.mockResolvedValue(payment);
            buyOrderService.fulfillBuyOrder.mockResolvedValue(undefined);

            await controller.handleWebhook(body, sigHeaders);

            expect(buyOrderService.fulfillBuyOrder).toHaveBeenCalledWith(ref);
        });

        it('should rely on the guard layer for signature verification', async () => {
            const ref = 'guard-verified-ref';
            const payment = { id: 41, orderId: 401, totalAmount: 100, reference: ref, userId: 7 };
            prisma.payment.findFirst.mockResolvedValue(payment);
            buyOrderService.fulfillBuyOrder.mockResolvedValue(undefined);

            await controller.handleWebhook({ event_type: 'payment_success', data: { accountRef: ref, amount: 100 } }, {});

            expect(buyOrderService.fulfillBuyOrder).toHaveBeenCalledWith(ref);
        });
    });

    describe('transfer handlers', () => {
        it('should no-op transfer success when reference is missing', async () => {
            const result = await controller.handleWebhook(
                { event_type: 'transfer.successful', data: { transaction: { transactionId: 't1' } } },
                sigHeaders
            );

            expect(result).toEqual({ success: true, message: 'Webhook processed' });
            expect(prisma.payment.findFirst).not.toHaveBeenCalledWith({ where: { reference: undefined } });
        });

        it('should no-op transfer failed when reference is missing', async () => {
            const result = await controller.handleWebhook(
                { event_type: 'transfer.failed', data: { transaction: { transactionId: 't2' } } },
                sigHeaders
            );

            expect(result).toEqual({ success: true, message: 'Webhook processed' });
            expect(prisma.payment.updateMany).not.toHaveBeenCalled();
        });

        it('should delegate transfer.successful SELL payouts to the shared reconciler', async () => {
            const ref = 'sell-success-ref';
            prisma.payment.findFirst.mockResolvedValue({ id: 70, orderId: 9001, reference: ref });
            prisma.payment.update.mockResolvedValue({ id: 70, orderId: 9001, reference: ref });
            sellPayoutReconciliationService.reconcileSellPayoutState.mockResolvedValue({
                order: { id: 9001 },
                provider: 'nomba',
                reference: ref,
                status: TransactionStatus.SUCCESS,
            });

            await controller.handleWebhook(transferCompleted(ref), sigHeaders);

            expect(prisma.$transaction).toHaveBeenCalled();
            expect(prisma.payment.update).toHaveBeenCalledWith({
                where: { id: 70 },
                data: expect.objectContaining({
                    status: TransactionStatus.SUCCESS,
                    paymentStatus: TransactionStatus.SUCCESS,
                }),
            });
            expect(sellPayoutReconciliationService.reconcileSellPayoutState).toHaveBeenCalledWith(
                expect.objectContaining({ payment: prisma.payment, order: prisma.order }),
                {
                orderId: 9001,
                provider: 'nomba',
                reference: ref,
                status: TransactionStatus.SUCCESS,
                },
            );
            expect(sellPayoutReconciliationService.executeSellPayoutSideEffects).toHaveBeenCalledWith(
                expect.objectContaining({
                    provider: 'nomba',
                    reference: ref,
                    status: TransactionStatus.SUCCESS,
                }),
            );
        });

        it('should stop after updating the payment when transfer.successful has no linked order', async () => {
            const ref = 'sell-success-no-order-ref';
            prisma.payment.findFirst.mockResolvedValue({ id: 74, orderId: null, reference: ref });
            prisma.payment.update.mockResolvedValue({ id: 74, orderId: null, reference: ref });

            await controller.handleWebhook(transferCompleted(ref), sigHeaders);

            expect(sellPayoutReconciliationService.reconcileSellPayoutState).not.toHaveBeenCalled();
            expect(sellPayoutReconciliationService.executeSellPayoutSideEffects).not.toHaveBeenCalled();
        });

        it('should delegate transfer.failed SELL payouts to the shared reconciler', async () => {
            const ref = 'sell-failed-ref';
            prisma.payment.findMany.mockResolvedValue([{ id: 71, orderId: 9001, userId: 16, totalAmount: 22000 }]);
            prisma.payment.updateMany.mockResolvedValue({ count: 1 });
            sellPayoutReconciliationService.reconcileSellPayoutState.mockResolvedValue({
                order: { id: 9001 },
                provider: 'nomba',
                reference: ref,
                status: TransactionStatus.FAILED,
            });

            await controller.handleWebhook(transferFailed(ref), sigHeaders);

            expect(prisma.$transaction).toHaveBeenCalled();
            expect(prisma.payment.updateMany).toHaveBeenCalledWith({
                where: { reference: ref },
                data: {
                    status: TransactionStatus.FAILED,
                    paymentStatus: TransactionStatus.FAILED,
                },
            });
            expect(sellPayoutReconciliationService.reconcileSellPayoutState).toHaveBeenCalledWith(
                expect.objectContaining({ payment: prisma.payment, order: prisma.order }),
                {
                orderId: 9001,
                provider: 'nomba',
                reference: ref,
                status: TransactionStatus.FAILED,
                },
            );
            expect(sellPayoutReconciliationService.executeSellPayoutSideEffects).toHaveBeenCalledWith(
                expect.objectContaining({
                    provider: 'nomba',
                    reference: ref,
                    status: TransactionStatus.FAILED,
                }),
            );
        });

        it('should skip payout reconciliation when transfer.failed has no linked SELL order', async () => {
            const ref = 'sell-failure-no-order-ref';
            prisma.payment.findMany.mockResolvedValue([{ id: 77, orderId: null, userId: 16, totalAmount: 22000 }]);
            prisma.payment.updateMany.mockResolvedValue({ count: 1 });

            await controller.handleWebhook(transferFailed(ref), sigHeaders);

            expect(sellPayoutReconciliationService.reconcileSellPayoutState).not.toHaveBeenCalled();
            expect(sellPayoutReconciliationService.executeSellPayoutSideEffects).not.toHaveBeenCalled();
        });
    });
});
