import { Test, TestingModule } from "@nestjs/testing";

jest.mock("../../../auth/guard", () => ({
    FincraWebhookGuard: class { isStub() { return true; } },
    __esModule: true,
}));

jest.mock("../../services", () => ({
    BankService: class { isStub() { return true; } },
    __esModule: true,
}));

import { FincraWebhookController } from "../fincra-webhook.controller";
import { BankService } from "../../services";
import { PrismaService } from "@/modules/core/prisma/services";

function makePrisma() {
    return {
        webhookLog: { upsert: jest.fn() },
        payment: { updateMany: jest.fn() },
    };
}

describe("FincraWebhookController", () => {
    let controller: FincraWebhookController;
    let prisma: ReturnType<typeof makePrisma>;
    let bankService: {
        paymentSuccessHandler: jest.Mock;
        paymentFailedHandler: jest.Mock;
        processAssetValueTransferToBankHandler: jest.Mock;
    };

    beforeEach(async () => {
        prisma = makePrisma();
        bankService = {
            paymentSuccessHandler: jest.fn(),
            paymentFailedHandler: jest.fn(),
            processAssetValueTransferToBankHandler: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            controllers: [FincraWebhookController],
            providers: [
                { provide: BankService, useValue: bankService },
                { provide: PrismaService, useValue: prisma },
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

    it("should return failure payload when handler throws", async () => {
        bankService.paymentSuccessHandler.mockRejectedValue(new Error("bank down"));

        const result = await controller.handleFincraWebhook({
            event: "collection.successful",
            data: { merchantReference: "ref-5", status: "successful" },
        } as any);

        expect(result).toEqual({ success: false, message: "bank down" });
    });
});