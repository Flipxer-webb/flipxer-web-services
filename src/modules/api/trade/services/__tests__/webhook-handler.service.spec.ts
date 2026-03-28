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

import { WebhookHandlerService } from "../webhook-handler.service";
import { DepositWebhookHandler } from "../webhook-handlers/deposit-webhook.handler";
import { SwapWebhookHandler } from "../webhook-handlers/swap-webhook.handler";
import { WithdrawalWebhookHandler } from "../webhook-handlers/withdrawal-webhook.handler";
import { OrderStatus } from "@prisma/client";

describe("WebhookHandlerService", () => {
    let service: WebhookHandlerService;
    let depositHandler: jest.Mocked<DepositWebhookHandler>;
    let swapHandler: jest.Mocked<SwapWebhookHandler>;
    let withdrawalHandler: jest.Mocked<WithdrawalWebhookHandler>;

    beforeEach(async () => {
        const mockDepositHandler = { handle: jest.fn().mockResolvedValue({ success: true }) };
        const mockSwapHandler = { handle: jest.fn().mockResolvedValue({ success: true }) };
        const mockWithdrawalHandler = { handle: jest.fn().mockResolvedValue({ success: true }) };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                WebhookHandlerService,
                { provide: DepositWebhookHandler, useValue: mockDepositHandler },
                { provide: SwapWebhookHandler, useValue: mockSwapHandler },
                { provide: WithdrawalWebhookHandler, useValue: mockWithdrawalHandler },
            ],
        }).compile();

        service = module.get<WebhookHandlerService>(WebhookHandlerService);
        depositHandler = module.get(DepositWebhookHandler);
        swapHandler = module.get(SwapWebhookHandler);
        withdrawalHandler = module.get(WithdrawalWebhookHandler);
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
            reason: "null",
            created_at: new Date().toISOString(),
            done_at: new Date().toISOString(),
        };

        it("should delegate to DepositWebhookHandler", async () => {
            await service.depositHandler(depositOptions);

            expect(depositHandler.handle).toHaveBeenCalledWith(depositOptions);
        });

        it("should return the handler result", async () => {
            depositHandler.handle.mockResolvedValue({ data: "deposit-result" } as any);

            const result = await service.depositHandler(depositOptions);

            expect(result).toEqual({ data: "deposit-result" });
        });
    });

    describe("swapTransactionHandler", () => {
        const swapOptions = {
            orderId: "swap-123",
            status: OrderStatus.completed,
        };

        it("should delegate to SwapWebhookHandler", async () => {
            await service.swapTransactionHandler(swapOptions);

            expect(swapHandler.handle).toHaveBeenCalledWith(swapOptions);
        });

        it("should propagate errors from swap handler", async () => {
            swapHandler.handle.mockRejectedValue(new Error("Swap failed"));

            await expect(service.swapTransactionHandler(swapOptions)).rejects.toThrow("Swap failed");
        });
    });

    describe("withdrawerTransactionHandler", () => {
        const withdrawOptions = {
            orderReference: "withdraw-ref-123",
            status: OrderStatus.done,
        };

        it("should delegate to WithdrawalWebhookHandler", async () => {
            await service.withdrawerTransactionHandler(withdrawOptions);

            expect(withdrawalHandler.handle).toHaveBeenCalledWith(withdrawOptions);
        });

        it("should propagate errors from withdrawal handler", async () => {
            withdrawalHandler.handle.mockRejectedValue(new Error("Withdrawal failed"));

            await expect(service.withdrawerTransactionHandler(withdrawOptions)).rejects.toThrow("Withdrawal failed");
        });
    });
});
