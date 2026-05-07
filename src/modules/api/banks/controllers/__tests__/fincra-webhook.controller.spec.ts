import { Test, TestingModule } from "@nestjs/testing";

jest.mock("../../../auth/guard", () => ({
    AuthGuard: class { canActivate() { return true; } },
    CountryBlockGuard: class { canActivate() { return true; } },
    EnabledAccountGuard: class { canActivate() { return true; } },
    FincraWebhookGuard: class { canActivate() { return true; } },
    NombaWebhookGuard: class { canActivate() { return true; } },
    QuidaxWebhookGuard: class { canActivate() { return true; } },
    SocketAuthGuard: class { canActivate() { return true; } },
    TransactionAmountGuard: class { canActivate() { return true; } },
    TwoFactorGuard: class { canActivate() { return true; } },
    __esModule: true,
}));

jest.mock("../../services", () => ({
    BankService: class { isStub() { return true; } },
    __esModule: true,
}));

jest.mock("../../../trade/services/buy-order.service", () => ({
    BuyOrderService: class { isStub() { return true; } },
    __esModule: true,
}));

jest.mock("@/modules/api/operations/services/slack-webhook.service", () => ({
    SlackWebhookService: class { isStub() { return true; } },
    __esModule: true,
}));

jest.mock("@/modules/api/user", () => {
    class AccountDeletedException extends Error {
        constructor() {
            super("Account deleted");
        }
    }
    class UserNotFoundException extends Error {
        constructor() {
            super("User not found");
        }
    }
    return {
        User: () => () => {},
        ClientData: () => () => {},
        UserModule: class {
            readonly __stub = true;
        },
        AccountDeletedException,
        UserNotFoundException,
        __esModule: true,
    };
});

import { FincraWebhookController } from "../fincra-webhook.controller";
import { BankService } from "../../services";
import { PrismaService } from "@/modules/core/prisma/services";
import { PaymentWebhookAdapterService } from "@/modules/factory/bank/services/payment-webhook-adapter.service";
import { BuyOrderService } from "../../../trade/services/buy-order.service";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { TransactionStatus } from "@prisma/client";
import { BuyRefundReconciliationService } from "../../../trade/services/buy-refund-reconciliation.service";

function makePrisma() {
    return {
        webhookLog: { upsert: jest.fn() },
        payment: {
            findUnique: jest.fn().mockResolvedValue(null),
            findMany: jest.fn().mockResolvedValue([]),
            update: jest.fn().mockResolvedValue({}),
        },
    };
}

describe("PaymentGatewayWebhookController", () => {
    let controller: FincraWebhookController;
    let prisma: ReturnType<typeof makePrisma>;
    let bankService: {
        paymentSuccessHandler: jest.Mock;
        paymentFailedHandler: jest.Mock;
        processAssetValueTransferToBankHandler: jest.Mock;
    };
    let buyOrderService: {
        fulfillBuyOrder: jest.Mock;
        handleWebhookBuyOrderPayment: jest.Mock;
    };
    let slackWebhookService: { sendWebhookFailureAlert: jest.Mock };
    let buyRefundReconciliationService: {
        reconcileRefundPayout: jest.Mock;
    };

    beforeEach(async () => {
        prisma = makePrisma();
        bankService = {
            paymentSuccessHandler: jest.fn(),
            paymentFailedHandler: jest.fn(),
            processAssetValueTransferToBankHandler: jest.fn(),
        };
        const fulfillBuyOrder = jest.fn();
        buyOrderService = {
            fulfillBuyOrder,
            handleWebhookBuyOrderPayment: jest
                .fn()
                .mockImplementation(async (options: { reference: string }) => {
                    await fulfillBuyOrder(options.reference);
                }),
        };
        slackWebhookService = { sendWebhookFailureAlert: jest.fn() };
        buyRefundReconciliationService = {
            reconcileRefundPayout: jest.fn().mockResolvedValue(false),
        };

        const module: TestingModule = await Test.createTestingModule({
            controllers: [FincraWebhookController],
            providers: [
                { provide: BankService, useValue: bankService },
                { provide: PrismaService, useValue: prisma },
                PaymentWebhookAdapterService,
                { provide: BuyOrderService, useValue: buyOrderService },
                { provide: SlackWebhookService, useValue: slackWebhookService },
                {
                    provide: BuyRefundReconciliationService,
                    useValue: buyRefundReconciliationService,
                },
            ],
        }).compile();

        controller = module.get(FincraWebhookController);
    });

    afterEach(() => jest.clearAllMocks());

    it("should reject payloads without a reference", async () => {
        const result = await controller.handleFincraWebhook({
            event: "collection.successful",
            data: { status: "successful" },
        } as any);

        expect(result).toEqual({ success: false, message: "No reference provided" });
    });

    it("should process successful collection webhook", async () => {
        const result = await controller.handleFincraWebhook({
            event: "collection.successful",
            data: { merchantReference: "ref-1", reference: "provider-1", status: "successful" },
        } as any);

        expect(prisma.webhookLog.upsert).toHaveBeenCalled();
        expect(prisma.payment.findMany).toHaveBeenCalledWith({
            where: { reference: "ref-1" },
            select: { id: true },
        });
        expect(bankService.paymentSuccessHandler).toHaveBeenCalledWith("ref-1");
        expect(result.success).toBe(true);
    });

    it("should route successful buy-order collections through BuyOrderService", async () => {
        prisma.payment.findUnique.mockResolvedValue({
            id: 21,
            orderId: 22,
            userId: 23,
            totalAmount: 1000,
            reference: "buy-ref-1",
            status: TransactionStatus.PENDING,
        });

        await controller.handleFincraWebhook({
            event: "collection.successful",
            data: {
                merchantReference: "buy-ref-1",
                reference: "provider-buy-1",
                status: "successful",
                amount: 1000,
            },
        } as any);

        expect(buyOrderService.handleWebhookBuyOrderPayment).toHaveBeenCalledWith(
            expect.objectContaining({
                payment: expect.objectContaining({ id: 21 }),
                reference: "buy-ref-1",
                provider: "fincra",
                event: expect.objectContaining({
                    amount: 1000,
                    providerReference: "provider-buy-1",
                }),
            }),
        );
        expect(buyOrderService.fulfillBuyOrder).toHaveBeenCalledWith("buy-ref-1");
        expect(bankService.paymentSuccessHandler).not.toHaveBeenCalled();
    });

    it("should persist underpaid Fincra buy payments and alert ops instead of fulfilling", async () => {
        prisma.payment.findUnique.mockResolvedValue({
            id: 31,
            orderId: 32,
            userId: 33,
            totalAmount: 1000,
            reference: "buy-underpay-1",
            status: TransactionStatus.PENDING,
        });

        await controller.handleFincraWebhook({
            event: "collection.successful",
            data: {
                merchantReference: "buy-underpay-1",
                reference: "provider-underpay-1",
                status: "successful",
                amountReceived: 800,
            },
        } as any);

        expect(buyOrderService.handleWebhookBuyOrderPayment).toHaveBeenCalledWith(
            expect.objectContaining({
                payment: expect.objectContaining({ id: 31 }),
                reference: "buy-underpay-1",
                provider: "fincra",
                event: expect.objectContaining({
                    amount: 800,
                    providerReference: "provider-underpay-1",
                }),
            }),
        );
        expect(slackWebhookService.sendWebhookFailureAlert).not.toHaveBeenCalled();
        expect(bankService.paymentSuccessHandler).not.toHaveBeenCalled();
    });

    it("should process failed collection webhook", async () => {
        const result = await controller.handleFincraWebhook({
            event: "collection.failed",
            data: { merchantReference: "ref-2", status: "failed" },
        } as any);

        expect(bankService.paymentFailedHandler).toHaveBeenCalledWith("ref-2");
        expect(result.success).toBe(true);
    });

    it("should process payout webhook events", async () => {
        await controller.handleFincraWebhook({
            event: "payout.successful",
            data: { merchantReference: "ref-3", status: "successful" },
        } as any);

        expect(buyRefundReconciliationService.reconcileRefundPayout).toHaveBeenCalledWith({
            provider: "fincra",
            reference: "ref-3",
            status: TransactionStatus.SUCCESS,
            externalReference: undefined,
        });
        expect(bankService.processAssetValueTransferToBankHandler).toHaveBeenCalledWith({
            paymentReference: "ref-3",
            transferToBankStatus: "SUCCESS",
        });
    });

    it("should stop after refund reconciliation on successful payout when the reference is a refund payout", async () => {
        buyRefundReconciliationService.reconcileRefundPayout.mockResolvedValue(true);

        await controller.handleFincraWebhook({
            event: "payout.successful",
            data: { merchantReference: "refund-ref-1", status: "successful" },
        } as any);

        expect(bankService.processAssetValueTransferToBankHandler).not.toHaveBeenCalled();
    });

    it("should reconcile failed refund payouts before falling back to the bank service", async () => {
        await controller.handleFincraWebhook({
            event: "payout.failed",
            data: { merchantReference: "ref-6", status: "failed" },
        } as any);

        expect(buyRefundReconciliationService.reconcileRefundPayout).toHaveBeenCalledWith({
            provider: "fincra",
            reference: "ref-6",
            status: TransactionStatus.FAILED,
            externalReference: undefined,
        });
        expect(bankService.processAssetValueTransferToBankHandler).toHaveBeenCalledWith({
            paymentReference: "ref-6",
            transferToBankStatus: "FAILED",
        });
    });

    it("should ignore unknown events but still return success", async () => {
        const result = await controller.handleFincraWebhook({
            event: "something.else",
            data: { merchantReference: "ref-4", status: "unknown" },
        } as any);

        expect(result).toEqual({ success: true, message: "Webhook processed for event: something.else" });
    });

    it("should rethrow when handler throws so Fincra can retry", async () => {
        bankService.paymentSuccessHandler.mockRejectedValue(new Error("bank down"));

        await expect(
            controller.handleFincraWebhook({
                event: "collection.successful",
                data: { merchantReference: "ref-5", status: "successful" },
            } as any),
        ).rejects.toThrow("bank down");
    });
});