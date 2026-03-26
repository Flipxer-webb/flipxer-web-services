/**
 * NombaWebhookController Tests
 *
 * Covers:
 * - Payload normalization (reference extraction for VA-credit, checkout, transfer events)
 * - Event type mapping for all NombaWebhookEventType values
 * - handleIncomingPayment: fulfillment routing, underpayment guard, missing reference
 * - handleWebhook: signature bypass in non-prod, test/verification requests
 */

import { Test, TestingModule } from '@nestjs/testing';
import { NombaWebhookController } from '../nomba-webhook.controller';
import { PrismaService } from '@/modules/core/prisma/services';
import { BuyOrderService } from '../../../trade/services/buy-order.service';
import { SlackWebhookService } from '@/modules/api/operations/services/slack-webhook.service';
import { TransactionStatus } from '@prisma/client';

// ─── mock factories ─────────────────────────────────────────

function mockPrisma() {
    return {
        payment: {
            findFirst: jest.fn(),
            findUnique: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn(),
        },
    };
}

function mockBuyOrderService() {
    return { fulfillBuyOrder: jest.fn() };
}

function mockSlackWebhookService() {
    return { sendWebhookFailureAlert: jest.fn() };
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

describe('NombaWebhookController', () => {
    let controller: NombaWebhookController;
    let prisma: ReturnType<typeof mockPrisma>;
    let buyOrderService: ReturnType<typeof mockBuyOrderService>;
    let slackService: ReturnType<typeof mockSlackWebhookService>;

    beforeEach(async () => {
        prisma = mockPrisma();
        buyOrderService = mockBuyOrderService();
        slackService = mockSlackWebhookService();

        const module: TestingModule = await Test.createTestingModule({
            controllers: [NombaWebhookController],
            providers: [
                { provide: PrismaService, useValue: prisma },
                { provide: BuyOrderService, useValue: buyOrderService },
                { provide: SlackWebhookService, useValue: slackService },
            ],
        }).compile();

        controller = module.get(NombaWebhookController);
    });

    // ── Normalization / Reference Extraction ─────────────────

    describe('normalizePayload — reference extraction', () => {
        it('should extract aliasAccountReference from VA payment_success (vact_transfer)', async () => {
            const ref = 'va-ref-alias-123';
            const payment = { id: 9, orderId: 98, totalAmount: 1000, reference: ref, userId: 7 };
            prisma.payment.findFirst.mockResolvedValue(payment);
            buyOrderService.fulfillBuyOrder.mockResolvedValue(undefined);

            await controller.handleWebhook(vaPaymentSuccess(ref, 1000), {});

            expect(buyOrderService.fulfillBuyOrder).toHaveBeenCalledWith(ref);
        });

        it('should extract accountRef from VA-credit webhooks', async () => {
            const ref = 'g156bb83hh82gg4h16b6gb088ha677';
            const payment = { id: 10, orderId: 99, totalAmount: 1000, reference: ref, userId: 7 };
            prisma.payment.findFirst.mockResolvedValue(payment);
            buyOrderService.fulfillBuyOrder.mockResolvedValue(undefined);

            await controller.handleWebhook(vaCredit(ref, 1000), {});

            expect(buyOrderService.fulfillBuyOrder).toHaveBeenCalledWith(ref);
        });

        it('should extract orderReference from checkout webhooks', async () => {
            const ref = 'order-ref-abc';
            const payment = { id: 11, orderId: 100, totalAmount: 2000, reference: ref, userId: 8 };
            prisma.payment.findFirst.mockResolvedValue(payment);
            buyOrderService.fulfillBuyOrder.mockResolvedValue(undefined);

            await controller.handleWebhook(checkoutSuccess(ref, 2000), {});

            expect(buyOrderService.fulfillBuyOrder).toHaveBeenCalledWith(ref);
        });

        it('should extract merchantTxRef from transfer webhooks', async () => {
            const ref = 'merch-ref-xyz';
            prisma.payment.updateMany.mockResolvedValue({ count: 1 });

            await controller.handleWebhook(transferCompleted(ref, 500), {});

            expect(prisma.payment.updateMany).toHaveBeenCalledWith({
                where: { reference: ref },
                data: {
                    status: TransactionStatus.SUCCESS,
                    paymentStatus: TransactionStatus.SUCCESS,
                },
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

            await controller.handleWebhook(body, {});

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

            await controller.handleWebhook(body, {});

            // The payment lookup goes through with 'account-ref-fallback', not 'data-ref'
            expect(prisma.payment.findFirst).toHaveBeenCalledWith({ where: { reference: 'account-ref-fallback' } });
        });

        it('should throw when no reference can be extracted from a payment event', async () => {
            const body = {
                event_type: 'virtual_account.credited',
                data: { amount: 500 }, // no reference fields at all
            };

            await expect(controller.handleWebhook(body, {})).rejects.toThrow(
                'Cannot process payment webhook: no reference could be extracted from the payload'
            );
        });

        it('should extract transaction.accountRef from payment_success webhooks (prod shape)', async () => {
            const ref = 'va-ref-prod-shape';
            const payment = { id: 50, orderId: 500, totalAmount: 1500, reference: ref, userId: 11 };
            prisma.payment.findFirst.mockResolvedValue(payment);
            buyOrderService.fulfillBuyOrder.mockResolvedValue(undefined);

            await controller.handleWebhook(paymentSuccessViaTransaction(ref, 1500), {});

            expect(prisma.payment.findFirst).toHaveBeenCalledWith({ where: { reference: ref } });
            expect(buyOrderService.fulfillBuyOrder).toHaveBeenCalledWith(ref);
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

            await controller.handleWebhook(body, {});

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

            await controller.handleWebhook(vaCredit(ref, 500), {});

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

            await controller.handleWebhook(body, {});

            expect(buyOrderService.fulfillBuyOrder).toHaveBeenCalledWith('ref-tc');
        });

        it('should map transfer.successful to payout_success', async () => {
            const ref = 'payout-ref';
            prisma.payment.updateMany.mockResolvedValue({ count: 1 });

            await controller.handleWebhook(transferCompleted(ref), {});

            expect(prisma.payment.updateMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ status: TransactionStatus.SUCCESS }),
                }),
            );
        });

        it('should map transfer.failed to payment_failed', async () => {
            const ref = 'fail-ref';
            prisma.payment.updateMany.mockResolvedValue({ count: 1 });

            await controller.handleWebhook(transferFailed(ref), {});

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
            const result = await controller.handleWebhook(body, {});
            expect(result).toEqual({ success: true, message: 'Webhook processed' });
        });
    });

    // ── handleIncomingPayment details ────────────────────────

    describe('handleIncomingPayment — fulfillment flow', () => {
        it('should trigger fulfillBuyOrder when payment has an orderId', async () => {
            const ref = 'buy-ref-1';
            const payment = { id: 30, orderId: 300, totalAmount: 1000, reference: ref, userId: 7 };
            prisma.payment.findFirst.mockResolvedValue(payment);
            buyOrderService.fulfillBuyOrder.mockResolvedValue(undefined);

            await controller.handleWebhook(vaCredit(ref, 1000), {});

            expect(buyOrderService.fulfillBuyOrder).toHaveBeenCalledWith(ref);
            // Should NOT update payment status directly — fulfillBuyOrder handles it
            expect(prisma.payment.update).not.toHaveBeenCalled();
        });

        it('should update payment to SUCCESS when payment has no orderId (generic)', async () => {
            const ref = 'generic-ref';
            const payment = { id: 31, orderId: null, totalAmount: 500, reference: ref, userId: 8 };
            prisma.payment.findFirst.mockResolvedValue(payment);

            await controller.handleWebhook(vaCredit(ref, 500), {});

            expect(buyOrderService.fulfillBuyOrder).not.toHaveBeenCalled();
            expect(prisma.payment.update).toHaveBeenCalledWith({
                where: { id: 31 },
                data: {
                    status: TransactionStatus.SUCCESS,
                    paymentStatus: TransactionStatus.SUCCESS,
                },
            });
        });

        it('should NOT fulfill and should alert Slack on underpayment', async () => {
            const ref = 'underpay-ref';
            const payment = { id: 32, orderId: 302, totalAmount: 1000, reference: ref, userId: 7 };
            prisma.payment.findFirst.mockResolvedValue(payment);

            // User sent 800 but expected 1000 (below 1% tolerance)
            await controller.handleWebhook(vaCredit(ref, 800), {});

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

        it('should fulfill when amount is within 1% tolerance of expected', async () => {
            const ref = 'almost-ref';
            const payment = { id: 33, orderId: 303, totalAmount: 1000, reference: ref, userId: 7 };
            prisma.payment.findFirst.mockResolvedValue(payment);
            buyOrderService.fulfillBuyOrder.mockResolvedValue(undefined);

            // 995 is above 99% of 1000 — should pass
            await controller.handleWebhook(vaCredit(ref, 995), {});

            expect(buyOrderService.fulfillBuyOrder).toHaveBeenCalledWith(ref);
        });

        it('should warn but not throw when no payment found for reference', async () => {
            const ref = 'orphan-ref';
            prisma.payment.findFirst.mockResolvedValue(null);

            // Should complete without error
            const result = await controller.handleWebhook(vaCredit(ref, 100), {});
            expect(result).toEqual({ success: true, message: 'Webhook processed' });
        });
    });

    // ── handleWebhook — entry point guards ───────────────────

    describe('handleWebhook — entry guards', () => {
        it('should return ok for empty/verification body', async () => {
            const result = await controller.handleWebhook({}, {});
            expect(result).toEqual({ status: 'ok', message: 'Webhook received' });
        });

        it('should return ok for null body', async () => {
            const result = await controller.handleWebhook(null, {});
            expect(result).toEqual({ status: 'ok', message: 'Webhook received' });
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

            await controller.handleWebhook(body, {});

            expect(buyOrderService.fulfillBuyOrder).toHaveBeenCalledWith(ref);
        });
    });
});
