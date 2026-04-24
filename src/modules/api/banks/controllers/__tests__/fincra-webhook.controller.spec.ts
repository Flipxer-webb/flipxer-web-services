import { Test, TestingModule } from "@nestjs/testing";

jest.mock("../../../auth/guard", () => ({
    FincraWebhookGuard: class { isStub() { return true; } },
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

import { FincraWebhookController } from "../fincra-webhook.controller";
import { BankService } from "../../services";
import { PrismaService } from "@/modules/core/prisma/services";
import { PaymentWebhookAdapterService } from "@/modules/factory/bank/services/payment-webhook-adapter.service";
import { BuyOrderService } from "../../../trade/services/buy-order.service";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { TransactionStatus } from "@prisma/client";

function makePrisma() {
    return {
        webhookLog: { upsert: jest.fn() },
        payment: {
            findUnique: jest.fn().mockResolvedValue(null),
            updateMany: jest.fn(),
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
    let buyOrderService: { fulfillBuyOrder: jest.Mock };
    let slackWebhookService: { sendWebhookFailureAlert: jest.Mock };

    beforeEach(async () => {
        prisma = makePrisma();
        bankService = {
            paymentSuccessHandler: jest.fn(),
            paymentFailedHandler: jest.fn(),
            processAssetValueTransferToBankHandler: jest.fn(),
        };
        buyOrderService = { fulfillBuyOrder: jest.fn() };
        slackWebhookService = { sendWebhookFailureAlert: jest.fn() };

        const module: TestingModule = await Test.createTestingModule({
            controllers: [FincraWebhookController],
            providers: [
                { provide: BankService, useValue: bankService },
                { provide: PrismaService, useValue: prisma },
                PaymentWebhookAdapterService,
                { provide: BuyOrderService, useValue: buyOrderService },
                { provide: SlackWebhookService, useValue: slackWebhookService },
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
        expect(prisma.payment.updateMany).toHaveBeenCalled();
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

        expect(prisma.payment.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 21 },
                data: expect.objectContaining({
                    receivedAmount: 1000,
                    externalReference: "provider-buy-1",
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

        expect(prisma.payment.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 31 },
                data: expect.objectContaining({
                    receivedAmount: 800,
                    narration: expect.stringContaining("Underpayment"),
                }),
            }),
        );
        expect(slackWebhookService.sendWebhookFailureAlert).toHaveBeenCalledWith(
            "fincra",
            "buy-underpay-1",
            expect.stringContaining("Underpayment"),
            expect.objectContaining({
                orderId: 32,
                userId: 33,
                expectedAmount: 1000,
                receivedAmount: 800,
            }),
        );
        expect(buyOrderService.fulfillBuyOrder).not.toHaveBeenCalled();
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

        expect(bankService.processAssetValueTransferToBankHandler).toHaveBeenCalledWith({
            paymentReference: "ref-3",
            transferToBankStatus: "SUCCESS",
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