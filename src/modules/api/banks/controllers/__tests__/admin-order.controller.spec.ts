import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { OrderCategory, OrderStatus, TransactionStatus } from "@prisma/client";

jest.mock("../../../auth/guard", () => ({
    AuthGuard: class { isStub() { return true; } },
    EnabledAccountGuard: class { isStub() { return true; } },
    __esModule: true,
}));

jest.mock("../../../authorize/guards/role.guard", () => ({
    RoleGuard: class { isStub() { return true; } },
    __esModule: true,
}));

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class { readonly __stub = true },
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    __esModule: true,
}));

jest.mock("../../services", () => ({
    BankService: class { isStub() { return true; } },
    __esModule: true,
}));

jest.mock("../../../trade/services/swap.service", () => ({
    SwapService: class { isStub() { return true; } },
    __esModule: true,
}));

jest.mock("../../../trade/services/buy-order.service", () => ({
    BuyOrderService: class { isStub() { return true; } },
    __esModule: true,
}));

jest.mock("../../../trade/services/stuck-order-reconciliation.service", () => ({
    StuckOrderReconciliationService: class { isStub() { return true; } },
    __esModule: true,
}));

import { AdminOrderController } from "../admin-order.controller";
import { BankService } from "../../services";
import { PrismaService } from "@/modules/core/prisma/services";
import { SwapService } from "../../../trade/services/swap.service";
import { BuyOrderService } from "../../../trade/services/buy-order.service";
import { StuckOrderReconciliationService } from "../../../trade/services/stuck-order-reconciliation.service";

function makePrisma() {
    return {
        user: { findUnique: jest.fn() },
        order: { findUnique: jest.fn(), findMany: jest.fn() },
        payment: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    };
}

describe("AdminOrderController", () => {
    let controller: AdminOrderController;
    let prisma: ReturnType<typeof makePrisma>;
    let bankService: { paymentSuccessHandler: jest.Mock };
    let swapService: { retryPendingSwap: jest.Mock };
    let buyOrderService: { fulfillBuyOrder: jest.Mock };
    let stuckOrderReconciliation: { reconcile: jest.Mock };

    const admin = { id: 1, email: "admin@flipxer.com" } as any;

    beforeEach(async () => {
        prisma = makePrisma();
        bankService = { paymentSuccessHandler: jest.fn() };
        swapService = { retryPendingSwap: jest.fn() };
        buyOrderService = { fulfillBuyOrder: jest.fn() };
        stuckOrderReconciliation = { reconcile: jest.fn() };

        const module: TestingModule = await Test.createTestingModule({
            controllers: [AdminOrderController],
            providers: [
                { provide: BankService, useValue: bankService },
                { provide: PrismaService, useValue: prisma },
                { provide: SwapService, useValue: swapService },
                { provide: BuyOrderService, useValue: buyOrderService },
                { provide: StuckOrderReconciliationService, useValue: stuckOrderReconciliation },
            ],
        }).compile();

        controller = module.get(AdminOrderController);
    });

    afterEach(() => jest.clearAllMocks());

    function mockAdminRole() {
        prisma.user.findUnique.mockResolvedValue({ role: { slug: "super-admin" } });
    }

    it("should reject non-admin access", async () => {
        prisma.user.findUnique.mockResolvedValue({ role: { slug: "admin" } });

        await expect(controller.getPendingBuyOrders(admin)).rejects.toThrow(ForbiddenException);
    });

    it("should complete a pending buy order", async () => {
        mockAdminRole();
        prisma.order.findUnique
            .mockResolvedValueOnce({
                id: 12,
                orderCategory: OrderCategory.BUY,
                status: OrderStatus.pending,
                streamlinedStatus: "pending",
                transactionId: "TX-12",
            })
            .mockResolvedValueOnce({
                id: 12,
                transactionId: "TX-12",
                status: OrderStatus.confirmed,
                streamlinedStatus: "completed",
                amount: 1,
                currency: "BTC",
                recipient: "bc1...",
            });
        prisma.payment.findFirst.mockResolvedValue({ reference: "pay-ref-1" });

        const result = await controller.completePendingOrder(admin, "12");

        expect(bankService.paymentSuccessHandler).toHaveBeenCalledWith("pay-ref-1");
        expect(result.message).toContain("completed successfully");
    });

    it("should return already completed for completed order", async () => {
        mockAdminRole();
        prisma.order.findUnique.mockResolvedValue({
            id: 12,
            orderCategory: OrderCategory.BUY,
            status: OrderStatus.confirmed,
            streamlinedStatus: "completed",
            transactionId: "TX-12",
        });

        const result = await controller.completePendingOrder(admin, "12");

        expect(result.message).toContain("already completed");
    });

    it("should throw when completing non-buy order", async () => {
        mockAdminRole();
        prisma.order.findUnique.mockResolvedValue({ id: 12, orderCategory: OrderCategory.SELL });

        await expect(controller.completePendingOrder(admin, "12")).rejects.toThrow(BadRequestException);
    });

    it("should list pending buy orders", async () => {
        mockAdminRole();
        prisma.order.findMany.mockResolvedValue([
            {
                id: 1,
                transactionId: "TX-1",
                user: { email: "user@flipxer.com" },
                amount: 100,
                currency: "BTC",
                status: OrderStatus.pending,
                paymentStatus: "PENDING",
                recipient: "bc1...",
                createdAt: new Date(),
            },
        ]);

        const result = await controller.getPendingBuyOrders(admin);

        expect(result.message).toContain("Found 1 pending buy orders");
        expect(result.data).toHaveLength(1);
    });

    it("should list stuck buy orders", async () => {
        mockAdminRole();
        prisma.payment.findMany.mockResolvedValue([
            {
                id: 44,
                reference: "pay-ref",
                totalAmount: 5000,
                status: TransactionStatus.SUCCESS,
                createdAt: new Date(),
                order: { id: 10, transactionId: "TX-10", amount: 0.1, currency: "BTC", status: OrderStatus.pending },
                user: { id: 5, email: "user@flipxer.com", firstName: "A", lastName: "B", cryptoSubAccountId: "qx-1" },
            },
        ]);

        const result = await controller.getStuckBuyOrders(admin);

        expect(result.message).toContain("Found 1 stuck buy orders");
        expect(result.data[0].paymentId).toBe(44);
    });

    it("should retry buy order fulfillment", async () => {
        mockAdminRole();
        prisma.order.findUnique
            .mockResolvedValueOnce({
                id: 9,
                orderCategory: OrderCategory.BUY,
                fulfilled: false,
                transactionId: "TX-9",
                user: { id: 2, email: "user@flipxer.com", cryptoSubAccountId: "qx-2" },
            })
            .mockResolvedValueOnce({
                id: 9,
                transactionId: "TX-9",
                status: OrderStatus.confirmed,
                streamlinedStatus: "completed",
                fulfilled: true,
                amount: 1,
                currency: "BTC",
            });
        prisma.payment.findFirst.mockResolvedValue({ id: 3, reference: "pay-9", status: TransactionStatus.SUCCESS });

        const result = await controller.retryBuyOrderFulfillment(admin, "9");

        expect(prisma.payment.update).toHaveBeenCalled();
        expect(buyOrderService.fulfillBuyOrder).toHaveBeenCalledWith("pay-9");
        expect(result.message).toContain("retry successful");
    });

    it("should retry a swap order", async () => {
        mockAdminRole();
        swapService.retryPendingSwap.mockResolvedValue({ message: "retried" });

        const result = await controller.retrySwapOrder(admin, "77");

        expect(swapService.retryPendingSwap).toHaveBeenCalledWith(77);
        expect(result.message).toBe("retried");
    });

    it("should run reconciliation", async () => {
        mockAdminRole();
        stuckOrderReconciliation.reconcile.mockResolvedValue({
            timestamp: new Date().toISOString(),
            stuckBuyOrders: { detected: 1, autoRetried: 1, retryFailed: 0, skippedNoWebhook: 0, details: [] },
            brokenLedgerOrders: { detected: 0, details: [] },
            preLedgerBackfill: { detected: 0, fixed: 0 },
            errors: [],
        });

        const result = await controller.runReconciliation(admin);

        expect(result.message).toContain("Reconciliation complete");
        expect(result.data.stuckBuyOrders.autoRetried).toBe(1);
    });
});