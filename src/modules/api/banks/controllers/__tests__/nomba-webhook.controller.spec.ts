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
import {
    OrderCategory,
    OrderStatus,
    OrderStreamlinedStatus,
    TransactionStatus,
} from '@prisma/client';
import { WithdrawalWebhookHandler } from '../../../trade/services/webhook-handlers/withdrawal-webhook.handler';
import { NotificationDispatcher } from '@/modules/api/notification/services/notification-dispatcher.service';
import { WsGateway } from '../../../trade/gateway/v1';

// ─── mock factories ─────────────────────────────────────────

function mockPrisma() {
    return {
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
    };
}

function mockBuyOrderService() {
    return { fulfillBuyOrder: jest.fn() };
}

function mockSlackWebhookService() {
    return { sendWebhookFailureAlert: jest.fn() };
}

function mockWithdrawalWebhookHandler() {
    return { refundSellOrderByOrderId: jest.fn().mockResolvedValue(undefined) };
}

function mockNotificationDispatcher() {
    return { notify: jest.fn().mockResolvedValue(undefined) };
}

function mockWsGateway() {
    return {
        notifyTransactionUpdate: jest.fn(),
        notifyWalletUpdate: jest.fn(),
    };
}

function makeSellOrder(overrides: Record<string, any> = {}) {
    return {
        id: 9001,
        orderCategory: OrderCategory.SELL,
        status: OrderStatus.processing,
        streamlinedStatus: OrderStreamlinedStatus.pending,
        paymentStatus: TransactionStatus.PENDING,
        transactionId: 'TXN-9001',
        amount: 100,
        currency: 'USDT',
        totalToReceiveInFiat: 22000,
        destinationBankName: 'Bank A',
        destinationBankAccountNumber: '1234567890',
        user: { id: 16, email: 'user@example.com' },
        createdAt: new Date('2026-04-16T10:00:00.000Z'),
        updatedAt: new Date('2026-04-16T10:00:00.000Z'),
        ...overrides,
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

/** Build a double-nested payout_success webhook body (real Nomba sandbox format). */
function payoutSuccessDoubleNested(merchantTxRef: string, amount = 1449) {
    return {
        event_type: 'payout_success',
        requestId: 'b1bc6551-b41d-4b18-8c6a-9951bc01d149',
        data: {
            event_type: 'payout_success',
            requestId: 'c7a5b6d7-d498-4888-b974-8519e10ac0be',
            data: {
                merchant: {
                    userId: 'c7a5b6d7-d498-4888-b974-8519e10ac0be',
                    walletId: '6752c1a888888hhhh55bced9f',
                    walletBalance: 4039647.16,
                },
                terminal: { terminalId: '', terminalLabel: '' },
                transaction: {
                    transactionId: 'API-TRANSFER-028706ba-0e2e-4da0-8678-e835a8b8c293',
                    type: 'transfer',
                    originatingFrom: 'api',
                    rrn: '251018131900',
                    sessionId: '260325515668563586728',
                    transactionAmount: amount,
                    fee: 50,
                    time: '2026-04-16T06:31:22.921658551',
                    merchantTxRef,
                    narration: 'Wallet withdrawal',
                },
                customer: {
                    accountNumber: '7061797925',
                    bankName: 'Paycom (Opay)',
                    senderName: 'Resolve',
                    recipientName: 'OLUKOLADE ABISOYE AKINYEYE',
                },
            },
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
    let withdrawalWebhookHandler: ReturnType<typeof mockWithdrawalWebhookHandler>;
    let notificationDispatcher: ReturnType<typeof mockNotificationDispatcher>;
    let wsGateway: ReturnType<typeof mockWsGateway>;

    /** Default headers with a dummy signature so the !signature guard passes */
    const sigHeaders = { 'nomba-signature': 'test-sig', 'nomba-timestamp': '1234567890' };

    beforeEach(async () => {
        prisma = mockPrisma();
        buyOrderService = mockBuyOrderService();
        slackService = mockSlackWebhookService();
        withdrawalWebhookHandler = mockWithdrawalWebhookHandler();
        notificationDispatcher = mockNotificationDispatcher();
        wsGateway = mockWsGateway();

        const module: TestingModule = await Test.createTestingModule({
            controllers: [NombaWebhookController],
            providers: [
                { provide: PrismaService, useValue: prisma },
                { provide: BuyOrderService, useValue: buyOrderService },
                { provide: SlackWebhookService, useValue: slackService },
                { provide: WithdrawalWebhookHandler, useValue: withdrawalWebhookHandler },
                { provide: NotificationDispatcher, useValue: notificationDispatcher },
                { provide: WsGateway, useValue: wsGateway },
            ],
        }).compile();

        controller = module.get(NombaWebhookController);

        // Bypass signature verification in tests (private method)
        jest.spyOn(controller as any, 'verifySignature').mockReturnValue(true);
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

    describe('verifySignature', () => {
        it('should return false when webhook secret is not configured', () => {
            const configModule = require('@/config');
            const oldOptions = configModule.nombaOptions;
            configModule.nombaOptions = { ...oldOptions, webhookSecret: undefined };

            const verifySignature = (NombaWebhookController as any).prototype.verifySignature;
            const result = verifySignature.call(controller, { event_type: 'payment_success', data: {} }, 'sig', '123');

            expect(result).toBe(false);
            configModule.nombaOptions = oldOptions;
        });

        it('should return false on signature length mismatch', () => {
            const configModule = require('@/config');
            const oldOptions = configModule.nombaOptions;
            configModule.nombaOptions = { ...oldOptions, webhookSecret: 'secret' };

            const hmacSpy = jest.spyOn(require('node:crypto'), 'createHmac').mockReturnValue({
                update: jest.fn().mockReturnThis(),
                digest: jest.fn().mockReturnValue('expected-signature-base64'),
            } as any);

            const verifySignature = (NombaWebhookController as any).prototype.verifySignature;
            const result = verifySignature.call(
                controller,
                {
                    event_type: 'payment_success',
                    requestId: 'r1',
                    data: {
                        merchant: { userId: 'u1', walletId: 'w1' },
                        transaction: {
                            transactionId: 't1',
                            type: 'vact_transfer',
                            time: 'now',
                            responseCode: 'null',
                        },
                    },
                },
                'short',
                'ts1'
            );

            expect(result).toBe(false);
            hmacSpy.mockRestore();
            configModule.nombaOptions = oldOptions;
        });

        it('should return true when timing-safe check passes', () => {
            const configModule = require('@/config');
            const oldOptions = configModule.nombaOptions;
            configModule.nombaOptions = { ...oldOptions, webhookSecret: 'secret' };

            const expectedSig = '1234567890123456';
            const hmacSpy = jest.spyOn(require('node:crypto'), 'createHmac').mockReturnValue({
                update: jest.fn().mockReturnThis(),
                digest: jest.fn().mockReturnValue(expectedSig),
            } as any);
            const timingSpy = jest.spyOn(require('node:crypto'), 'timingSafeEqual').mockReturnValue(true);

            const verifySignature = (NombaWebhookController as any).prototype.verifySignature;
            const result = verifySignature.call(
                controller,
                {
                    event_type: 'payment_success',
                    requestId: 'rid',
                    data: {
                        merchant: { userId: 'u1', walletId: 'w1' },
                        transaction: {
                            transactionId: 't1',
                            type: 'vact_transfer',
                            time: '2026-03-29T00:00:00Z',
                            responseCode: '',
                        },
                    },
                },
                expectedSig,
                '12345'
            );

            expect(result).toBe(true);
            expect(timingSpy).toHaveBeenCalled();

            hmacSpy.mockRestore();
            timingSpy.mockRestore();
            configModule.nombaOptions = oldOptions;
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
            expect(result).toEqual({ status: 'ok', message: 'Webhook received' });
        });

        it('should return ok for null body', async () => {
            const result = await controller.handleWebhook(null, sigHeaders);
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

            await controller.handleWebhook(body, sigHeaders);

            expect(buyOrderService.fulfillBuyOrder).toHaveBeenCalledWith(ref);
        });

        it('should reject when signature header is missing', async () => {
            await expect(
                controller.handleWebhook({ event_type: 'payment_success', data: { reference: 'r1' } }, {})
            ).rejects.toThrow('Missing webhook signature');
        });

        it('should reject when signature verification fails', async () => {
            (controller as any).verifySignature.mockReturnValueOnce(false);

            await expect(
                controller.handleWebhook(
                    { event_type: 'payment_success', data: { reference: 'r1' } },
                    { 'nomba-signature': 'bad', 'nomba-timestamp': '1' }
                )
            ).rejects.toThrow('Invalid webhook signature');
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

        it('should unwrap double-nested payout_success and complete SELL order', async () => {
            const ref = 'sell-double-nested-ref';
            const processingOrder = makeSellOrder();
            const completedOrder = makeSellOrder({
                status: OrderStatus.done,
                streamlinedStatus: OrderStreamlinedStatus.completed,
                paymentStatus: TransactionStatus.SUCCESS,
                fulfilled: true,
                reason: null,
            });
            prisma.payment.findFirst.mockResolvedValue({ id: 80, orderId: processingOrder.id, reference: ref });
            prisma.payment.update.mockResolvedValue({ id: 80, orderId: processingOrder.id, reference: ref });
            prisma.order.findUnique.mockResolvedValue(processingOrder);
            prisma.order.update.mockResolvedValue(completedOrder);

            await controller.handleWebhook(payoutSuccessDoubleNested(ref, 1449), sigHeaders);

            expect(prisma.payment.findFirst).toHaveBeenCalledWith({ where: { reference: ref } });
            expect(prisma.order.update).toHaveBeenCalledWith({
                where: { id: processingOrder.id },
                data: expect.objectContaining({
                    status: OrderStatus.done,
                    streamlinedStatus: OrderStreamlinedStatus.completed,
                    paymentStatus: TransactionStatus.SUCCESS,
                    fulfilled: true,
                }),
            });
        });

        it('should complete a processing SELL payout on transfer.successful', async () => {
            const ref = 'sell-success-ref';
            const processingOrder = makeSellOrder();
            const completedOrder = makeSellOrder({
                status: OrderStatus.done,
                streamlinedStatus: OrderStreamlinedStatus.completed,
                paymentStatus: TransactionStatus.SUCCESS,
                fulfilled: true,
                reason: null,
                updatedAt: new Date('2026-04-16T10:05:00.000Z'),
            });
            prisma.payment.findFirst.mockResolvedValue({ id: 70, orderId: processingOrder.id, reference: ref });
            prisma.payment.update.mockResolvedValue({ id: 70, orderId: processingOrder.id, reference: ref });
            prisma.order.findUnique.mockResolvedValue(processingOrder);
            prisma.order.update.mockResolvedValue(completedOrder);

            await controller.handleWebhook(transferCompleted(ref), sigHeaders);

            expect(prisma.order.update).toHaveBeenCalledWith({
                where: { id: processingOrder.id },
                data: {
                    status: OrderStatus.done,
                    streamlinedStatus: OrderStreamlinedStatus.completed,
                    paymentStatus: TransactionStatus.SUCCESS,
                    fulfilled: true,
                    reason: null,
                },
            });
            expect(wsGateway.notifyTransactionUpdate).toHaveBeenCalledWith(
                processingOrder.user.id,
                expect.objectContaining({
                    type: 'transaction_update',
                    transaction: expect.objectContaining({
                        status: OrderStatus.done,
                        streamlinedStatus: OrderStreamlinedStatus.completed,
                    }),
                }),
            );
            expect(wsGateway.notifyWalletUpdate).toHaveBeenCalledWith(processingOrder.user.id);
            expect(notificationDispatcher.notify).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: processingOrder.user.id,
                    title: 'Sell order completed',
                    body: 'Your sell order of 100 USDT has been completed. ₦22000 was sent to Bank A (1234567890). Transaction ID: TXN-9001.',
                }),
            );
        });

        it('should use the generic bank label when transfer.successful has no bank metadata', async () => {
            const ref = 'sell-success-generic-bank-ref';
            const processingOrder = makeSellOrder({
                destinationBankName: null,
                destinationBankAccountNumber: null,
            });
            const completedOrder = makeSellOrder({
                destinationBankName: null,
                destinationBankAccountNumber: null,
                status: OrderStatus.done,
                streamlinedStatus: OrderStreamlinedStatus.completed,
                paymentStatus: TransactionStatus.SUCCESS,
                fulfilled: true,
                reason: null,
                updatedAt: new Date('2026-04-16T10:05:30.000Z'),
            });
            prisma.payment.findFirst.mockResolvedValue({ id: 73, orderId: processingOrder.id, reference: ref });
            prisma.payment.update.mockResolvedValue({ id: 73, orderId: processingOrder.id, reference: ref });
            prisma.order.findUnique.mockResolvedValue(processingOrder);
            prisma.order.update.mockResolvedValue(completedOrder);

            await controller.handleWebhook(transferCompleted(ref), sigHeaders);

            expect(notificationDispatcher.notify).toHaveBeenCalledWith(
                expect.objectContaining({
                    body: 'Your sell order of 100 USDT has been completed. ₦22000 was sent to your bank. Transaction ID: TXN-9001.',
                }),
            );
        });

        it('should stop after updating the payment when transfer.successful has no linked order', async () => {
            const ref = 'sell-success-no-order-ref';
            prisma.payment.findFirst.mockResolvedValue({ id: 74, orderId: null, reference: ref });
            prisma.payment.update.mockResolvedValue({ id: 74, orderId: null, reference: ref });

            await controller.handleWebhook(transferCompleted(ref), sigHeaders);

            expect(prisma.order.findUnique).not.toHaveBeenCalled();
            expect(prisma.order.update).not.toHaveBeenCalled();
            expect(notificationDispatcher.notify).not.toHaveBeenCalled();
        });

        it('should ignore transfer.successful when the linked order is not a SELL order', async () => {
            const ref = 'sell-success-non-sell-ref';
            prisma.payment.findFirst.mockResolvedValue({ id: 75, orderId: 9002, reference: ref });
            prisma.payment.update.mockResolvedValue({ id: 75, orderId: 9002, reference: ref });
            prisma.order.findUnique.mockResolvedValue(
                makeSellOrder({
                    id: 9002,
                    orderCategory: OrderCategory.BUY,
                }),
            );

            await controller.handleWebhook(transferCompleted(ref), sigHeaders);

            expect(prisma.order.update).not.toHaveBeenCalled();
            expect(wsGateway.notifyTransactionUpdate).not.toHaveBeenCalled();
            expect(notificationDispatcher.notify).not.toHaveBeenCalled();
        });

        it('should ignore late transfer.successful events after a SELL payout is already completed', async () => {
            const ref = 'sell-success-late-ref';
            prisma.payment.findFirst.mockResolvedValue({ id: 76, orderId: 9003, reference: ref });
            prisma.payment.update.mockResolvedValue({ id: 76, orderId: 9003, reference: ref });
            prisma.order.findUnique.mockResolvedValue(
                makeSellOrder({
                    id: 9003,
                    status: OrderStatus.done,
                    streamlinedStatus: OrderStreamlinedStatus.completed,
                    paymentStatus: TransactionStatus.SUCCESS,
                }),
            );

            await controller.handleWebhook(transferCompleted(ref), sigHeaders);

            expect(prisma.order.update).not.toHaveBeenCalled();
            expect(wsGateway.notifyWalletUpdate).not.toHaveBeenCalled();
            expect(notificationDispatcher.notify).not.toHaveBeenCalled();
        });

        it('should fail a processing SELL payout on transfer.failed and initiate a refund', async () => {
            const ref = 'sell-failed-ref';
            const processingOrder = makeSellOrder();
            const failedOrder = makeSellOrder({
                status: OrderStatus.failed,
                streamlinedStatus: OrderStreamlinedStatus.failed,
                paymentStatus: TransactionStatus.FAILED,
                fulfilled: false,
                reason: `Nomba payout failed for reference: ${ref}`,
                updatedAt: new Date('2026-04-16T10:06:00.000Z'),
            });
            prisma.payment.findMany.mockResolvedValue([{ id: 71, orderId: processingOrder.id, userId: 16, totalAmount: 22000 }]);
            prisma.payment.updateMany.mockResolvedValue({ count: 1 });
            prisma.order.findUnique.mockResolvedValue(processingOrder);
            prisma.order.update.mockResolvedValue(failedOrder);

            await controller.handleWebhook(transferFailed(ref), sigHeaders);

            expect(prisma.order.update).toHaveBeenCalledWith({
                where: { id: processingOrder.id },
                data: {
                    status: OrderStatus.failed,
                    streamlinedStatus: OrderStreamlinedStatus.failed,
                    paymentStatus: TransactionStatus.FAILED,
                    fulfilled: false,
                    reason: `Nomba payout failed for reference: ${ref}`,
                },
            });
            expect(withdrawalWebhookHandler.refundSellOrderByOrderId).toHaveBeenCalledWith(processingOrder.id);
            expect(notificationDispatcher.notify).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: processingOrder.user.id,
                    title: 'Sell order failed',
                }),
            );
            expect(slackService.sendWebhookFailureAlert).toHaveBeenCalledWith(
                'nomba',
                ref,
                expect.stringContaining('payout FAILED'),
                expect.objectContaining({ orderId: processingOrder.id, userId: 16, amount: 22000 }),
            );
        });

        it('should skip refund handling when transfer.failed has no linked SELL order', async () => {
            const ref = 'sell-failure-no-order-ref';
            prisma.payment.findMany.mockResolvedValue([{ id: 77, orderId: null, userId: 16, totalAmount: 22000 }]);
            prisma.payment.updateMany.mockResolvedValue({ count: 1 });

            await controller.handleWebhook(transferFailed(ref), sigHeaders);

            expect(prisma.order.findUnique).not.toHaveBeenCalled();
            expect(prisma.order.update).not.toHaveBeenCalled();
            expect(withdrawalWebhookHandler.refundSellOrderByOrderId).not.toHaveBeenCalled();
            expect(notificationDispatcher.notify).not.toHaveBeenCalled();
        });

        it('should ignore transfer.failed when the linked order is not a SELL order', async () => {
            const ref = 'sell-failure-non-sell-ref';
            prisma.payment.findMany.mockResolvedValue([{ id: 78, orderId: 9004, userId: 16, totalAmount: 22000 }]);
            prisma.payment.updateMany.mockResolvedValue({ count: 1 });
            prisma.order.findUnique.mockResolvedValue(
                makeSellOrder({
                    id: 9004,
                    orderCategory: OrderCategory.BUY,
                }),
            );

            await controller.handleWebhook(transferFailed(ref), sigHeaders);

            expect(prisma.order.update).not.toHaveBeenCalled();
            expect(withdrawalWebhookHandler.refundSellOrderByOrderId).not.toHaveBeenCalled();
            expect(notificationDispatcher.notify).not.toHaveBeenCalled();
            expect(slackService.sendWebhookFailureAlert).not.toHaveBeenCalled();
        });

        it('should ignore late transfer.failed events after a SELL payout is already completed', async () => {
            const ref = 'sell-late-failure-ref';
            prisma.payment.findMany.mockResolvedValue([{ id: 72, orderId: 9001, userId: 16, totalAmount: 22000 }]);
            prisma.payment.updateMany.mockResolvedValue({ count: 1 });
            prisma.order.findUnique.mockResolvedValue(
                makeSellOrder({
                    status: OrderStatus.done,
                    streamlinedStatus: OrderStreamlinedStatus.completed,
                    paymentStatus: TransactionStatus.SUCCESS,
                }),
            );

            await controller.handleWebhook(transferFailed(ref), sigHeaders);

            expect(prisma.order.update).not.toHaveBeenCalled();
            expect(withdrawalWebhookHandler.refundSellOrderByOrderId).not.toHaveBeenCalled();
            expect(notificationDispatcher.notify).not.toHaveBeenCalled();
            expect(slackService.sendWebhookFailureAlert).not.toHaveBeenCalled();
        });
    });
});
