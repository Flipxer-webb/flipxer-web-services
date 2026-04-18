import { ForbiddenException, BadRequestException } from "@nestjs/common";
import { BankService } from "../index";
import { TransactionStatus, OrderCategory, OrderStatus, OrderStreamlinedStatus } from "@prisma/client";
import { BankDetailNotFoundException } from "../../errors";

// Stub heavy imports that the service module pulls in transitively
jest.mock("@/modules/api/trade/gateway/v1", () => ({
    WsGateway: class { isStub() { return true; } },
}));
jest.mock("@/modules/core/messages/services/notification.service", () => ({
    NotificationMessageService: class { isStub() { return true; } },
}));
jest.mock("@/modules/api/notification/services/notification-dispatcher.service", () => ({
    NotificationDispatcher: class { isStub() { return true; } },
}));
jest.mock("@/modules/api/auth", () => ({
    UserNotFoundException: class extends Error {
        constructor(m: string) { super(m); this.name = "UserNotFoundException"; }
    },
    __esModule: true,
}));
jest.mock("@/utils", () => ({
    buildResponse: jest.fn((opts) => ({ success: true, message: opts.message, data: opts.data })),
    ApiResponse: class { isStub() { return true; } },
    generateId: jest.fn(() => "GEN-REF-001"),
}));

// ---- helpers ----

function makePrisma() {
    return {
        user: {
            findUnique: jest.fn(),
            findFirst: jest.fn(),
        },
        bankDetail: {
            create: jest.fn(),
            findMany: jest.fn(),
            findUnique: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
        },
        payment: {
            findUnique: jest.fn(),
            update: jest.fn(),
        },
        order: {
            findUnique: jest.fn(),
            update: jest.fn(),
            create: jest.fn(),
        },
    };
}

function makeFincra() {
    return { getBanks: jest.fn(), verifyTransaction: jest.fn() };
}
function makeNomba() {
    return {
        getBanks: jest.fn(),
        initializePayment: jest.fn(),
        verifyTransaction: jest.fn(),
        resolveBankAccount: jest.fn(),
    };
}
function makeQuidax() {
    return {
        createWithdrawerRequest: jest.fn(),
        getSingleMarketTicker: jest.fn(),
    };
}
function makeNotificationMessage() {
    return { sellTransactionSuccess: jest.fn().mockReturnValue("Payment sent!") };
}
function makeWsGateway() {
    return { notifyTransactionUpdate: jest.fn() };
}
function makeBankCache() {
    return { getCachedVerification: jest.fn(), cacheVerification: jest.fn() };
}
function makeNotificationDispatcher() {
    return { notify: jest.fn().mockResolvedValue(undefined) };
}
function makeInboundFiatPayments() {
    return {
        initializePayment: jest.fn(),
        verifyCheckout: jest.fn(),
        resolveBankAccount: jest.fn(),
    };
}

describe("BankService", () => {
    let prisma: ReturnType<typeof makePrisma>;
    let fincra: ReturnType<typeof makeFincra>;
    let nomba: ReturnType<typeof makeNomba>;
    let quidax: ReturnType<typeof makeQuidax>;
    let notifMsg: ReturnType<typeof makeNotificationMessage>;
    let ws: ReturnType<typeof makeWsGateway>;
    let bankCache: ReturnType<typeof makeBankCache>;
    let notifDispatcher: ReturnType<typeof makeNotificationDispatcher>;
    let inboundFiatPayments: ReturnType<typeof makeInboundFiatPayments>;
    let service: BankService;

    beforeEach(() => {
        prisma = makePrisma();
        fincra = makeFincra();
        nomba = makeNomba();
        quidax = makeQuidax();
        notifMsg = makeNotificationMessage();
        ws = makeWsGateway();
        bankCache = makeBankCache();
        notifDispatcher = makeNotificationDispatcher();
        inboundFiatPayments = makeInboundFiatPayments();

        service = new BankService(
            prisma as any,
            fincra as any,
            nomba as any,
            quidax as any,
            notifMsg as any,
            ws as any,
            bankCache as any,
            notifDispatcher as any,
            inboundFiatPayments as any,
        );
    });

    // ============ getListOfBanks ============

    describe("getListOfBanks", () => {
        it("returns banks from Nomba when available", async () => {
            nomba.getBanks.mockResolvedValue({
                data: [{ code: "044", name: "Access Bank" }],
            });

            const res = await service.getListOfBanks();

            expect(res.data).toEqual([{ code: "044", name: "Access Bank" }]);
            expect(fincra.getBanks).not.toHaveBeenCalled();
        });

        it("falls back to Fincra when Nomba returns empty list", async () => {
            nomba.getBanks.mockResolvedValue({ data: [] });
            fincra.getBanks.mockResolvedValue({
                data: [{ code: "058", name: "GTBank" }],
            });

            const res = await service.getListOfBanks();

            expect(res.data).toEqual([{ code: "058", name: "GTBank" }]);
        });

        it("falls back to Fincra when Nomba throws", async () => {
            nomba.getBanks.mockRejectedValue(new Error("timeout"));
            fincra.getBanks.mockResolvedValue({
                data: [{ code: "011", name: "First Bank" }],
            });

            const res = await service.getListOfBanks();

            expect(res.data).toEqual([{ code: "011", name: "First Bank" }]);
        });

        it("throws when both Nomba and Fincra fail", async () => {
            nomba.getBanks.mockRejectedValue(new Error("nomba down"));
            fincra.getBanks.mockRejectedValue(new Error("fincra down"));

            await expect(service.getListOfBanks()).rejects.toThrow("fincra down");
        });
    });

    // ============ initializeNombaCheckout ============

    describe("initializeNombaCheckout", () => {
        it("throws when user not found", async () => {
            prisma.user.findUnique.mockResolvedValue(null);

            await expect(service.initializeNombaCheckout(999, 5000)).rejects.toThrow();
        });

        it("returns checkout link on success", async () => {
            prisma.user.findUnique.mockResolvedValue({
                id: 1,
                email: "a@b.com",
                firstName: "A",
                lastName: "B",
            });
            inboundFiatPayments.initializePayment.mockResolvedValue({
                provider: "nomba",
                mode: "checkout",
                reference: "ORD-1",
                amount: 5000,
                expiryAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
                authorizationUrl: "https://nomba/pay",
            });

            const res = await service.initializeNombaCheckout(1, 5000);

            expect(inboundFiatPayments.initializePayment).toHaveBeenCalledWith(
                expect.objectContaining({
                    provider: "nomba",
                    amount: 5000,
                }),
            );
            expect((res.data as any).checkoutLink).toBe("https://nomba/pay");
        });

        it("supports generic checkout with explicit fincra provider", async () => {
            prisma.user.findUnique.mockResolvedValue({
                id: 2,
                email: "f@b.com",
                firstName: "Fin",
                lastName: "Cra",
            });
            inboundFiatPayments.initializePayment.mockResolvedValue({
                provider: "fincra",
                mode: "checkout",
                reference: "FIN-1",
                amount: 7500,
                expiryAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
                authorizationUrl: "https://fincra/pay",
            });

            const res = await service.initializeCheckout(2, 7500, undefined, "fincra");

            expect(inboundFiatPayments.initializePayment).toHaveBeenCalledWith(
                expect.objectContaining({ provider: "fincra" }),
            );
            expect((res.data as any).provider).toBe("fincra");
            expect((res.data as any).checkoutLink).toBe("https://fincra/pay");
        });

        it("rejects unsupported providers before initializing checkout", async () => {
            await expect(
                service.initializeCheckout(2, 7500, undefined, "stripe" as any),
            ).rejects.toBeInstanceOf(BadRequestException);

            expect(prisma.user.findUnique).not.toHaveBeenCalled();
            expect(inboundFiatPayments.initializePayment).not.toHaveBeenCalled();
        });
    });

    describe("verifyNombaCheckout", () => {
        it("returns mapped checkout status", async () => {
            inboundFiatPayments.verifyCheckout.mockResolvedValue({
                provider: "nomba",
                data: { status: "success", orderReference: "ORD-1" },
            });

            const result = await service.verifyNombaCheckout("ORD-1");

            expect(inboundFiatPayments.verifyCheckout).toHaveBeenCalledWith({
                provider: "nomba",
                reference: "ORD-1",
            });
            expect(result.data).toEqual({ status: "success", orderReference: "ORD-1" });
        });

        it("rejects unsupported providers before verifying checkout", async () => {
            await expect(service.verifyCheckout("ORD-1", "stripe" as any)).rejects.toBeInstanceOf(
                BadRequestException,
            );

            expect(inboundFiatPayments.verifyCheckout).not.toHaveBeenCalled();
        });
    });

    // ============ verifyBankAccount ============

    describe("verifyBankAccount", () => {
        it("returns cached result when available", async () => {
            bankCache.getCachedVerification.mockResolvedValue({
                accountName: "John Doe",
                accountNumber: "0123456789",
            });

            const res = await service.verifyBankAccount({
                bankCode: "044",
                accountNumber: "0123456789",
            } as any);

            expect((res.data as any).fromCache).toBe(true);
            expect(inboundFiatPayments.resolveBankAccount).not.toHaveBeenCalled();
        });

        it("calls Nomba when cache misses and caches result", async () => {
            bankCache.getCachedVerification.mockResolvedValue(null);
            inboundFiatPayments.resolveBankAccount.mockResolvedValue({
                provider: "nomba",
                accountName: "Jane Doe",
                accountNumber: "9876543210",
            });

            const res = await service.verifyBankAccount({
                bankCode: "058",
                accountNumber: "9876543210",
            } as any);

            expect(res.data.accountName).toBe("Jane Doe");
            expect(inboundFiatPayments.resolveBankAccount).toHaveBeenCalledWith({
                provider: "nomba",
                bankCode: "058",
                accountNumber: "9876543210",
            });
            expect(bankCache.cacheVerification).toHaveBeenCalledWith(
                "058",
                "9876543210",
                "Jane Doe",
            );
        });

        it("throws when Nomba returns no data", async () => {
            bankCache.getCachedVerification.mockResolvedValue(null);
            inboundFiatPayments.resolveBankAccount.mockResolvedValue({
                provider: "nomba",
                accountName: "",
                accountNumber: "",
            });

            await expect(
                service.verifyBankAccount({ bankCode: "044", accountNumber: "000" } as any),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it("rejects unsupported providers before bank verification", async () => {
            await expect(
                service.verifyBankAccount(
                    { bankCode: "044", accountNumber: "0123456789" } as any,
                    "stripe" as any,
                ),
            ).rejects.toBeInstanceOf(BadRequestException);

            expect(bankCache.getCachedVerification).not.toHaveBeenCalled();
            expect(inboundFiatPayments.resolveBankAccount).not.toHaveBeenCalled();
        });
    });

    // ============ CRUD bank details ============

    describe("create", () => {
        it("throws ForbiddenException for ADMIN user type", async () => {
            prisma.user.findUnique.mockResolvedValue({ id: 1, userType: "ADMIN" });

            await expect(
                service.create(1, { bankName: "X", accountName: "Y", accountNumber: "Z", bankCode: "001" } as any),
            ).rejects.toBeInstanceOf(ForbiddenException);
        });

        it("creates bank detail for INDIVIDUAL user", async () => {
            prisma.user.findUnique.mockResolvedValue({ id: 1, userType: "INDIVIDUAL" });
            prisma.bankDetail.create.mockResolvedValue({ id: 50 });

            const res = await service.create(1, {
                bankName: "GTBank",
                accountName: "M",
                accountNumber: "1234567890",
                bankCode: "058",
            } as any);

            expect(res.data.id).toBe(50);
        });
    });

    describe("findAll", () => {
        it("throws when user not found", async () => {
            prisma.user.findUnique.mockResolvedValue(null);

            await expect(service.findAll(999)).rejects.toThrow();
        });

        it("returns bank details for existing user", async () => {
            prisma.user.findUnique.mockResolvedValue({ id: 1 });
            prisma.bankDetail.findMany.mockResolvedValue([{ id: 50 }]);

            const res = await service.findAll(1);

            expect(res.data).toEqual([{ id: 50 }]);
        });
    });

    describe("findOne", () => {
        it("throws BankDetailNotFoundException when belongs to another user", async () => {
            prisma.bankDetail.findUnique.mockResolvedValue({ id: 50, userId: 2 });

            await expect(service.findOne(1, 50)).rejects.toBeInstanceOf(BankDetailNotFoundException);
        });

        it("returns bank detail for owner", async () => {
            prisma.bankDetail.findUnique.mockResolvedValue({ id: 50, userId: 1 });

            const res = await service.findOne(1, 50);

            expect(res.data.id).toBe(50);
        });
    });

    describe("update", () => {
        it("throws when bank detail does not belong to user", async () => {
            prisma.bankDetail.findUnique.mockResolvedValue({ id: 50, userId: 999 });

            await expect(service.update(1, 50, {} as any)).rejects.toBeInstanceOf(
                BankDetailNotFoundException,
            );
        });

        it("updates and returns bank detail", async () => {
            prisma.bankDetail.findUnique.mockResolvedValue({
                id: 50,
                userId: 1,
                bankName: "Old",
                accountName: "Old N",
                accountNumber: "000",
            });
            prisma.bankDetail.update.mockResolvedValue({ id: 50, bankName: "New" });

            const res = await service.update(1, 50, { bankName: "New" } as any);

            expect(res.data.bankName).toBe("New");
        });
    });

    describe("remove", () => {
        it("throws when bank detail does not belong to user", async () => {
            prisma.bankDetail.findUnique.mockResolvedValue({ id: 50, userId: 999 });

            await expect(service.remove(1, 50)).rejects.toBeInstanceOf(BankDetailNotFoundException);
        });

        it("deletes bank detail", async () => {
            prisma.bankDetail.findUnique.mockResolvedValue({ id: 50, userId: 1 });
            prisma.bankDetail.delete.mockResolvedValue(undefined);

            const res = await service.remove(1, 50);

            expect(res.data).toBeNull();
            expect(prisma.bankDetail.delete).toHaveBeenCalledWith({ where: { id: 50 } });
        });
    });

    // ============ validateTransactionRef ============

    describe("validateTransactionRef", () => {
        it("throws when reference not found", async () => {
            prisma.payment.findUnique.mockResolvedValue(null);

            await expect(service.validateTransactionRef("REF-X")).rejects.toThrow();
        });

        it("returns payment when found", async () => {
            const payment = { id: 1, reference: "REF-A" };
            prisma.payment.findUnique.mockResolvedValue(payment);

            const result = await service.validateTransactionRef("REF-A");

            expect(result).toEqual(payment);
        });
    });

    describe("verifyFincraTransactionHandler", () => {
        it("returns fincra verification response directly", async () => {
            fincra.verifyTransaction.mockResolvedValue({
                status: true,
                data: { reference: "REF-200" },
            });

            const result = await service.verifyFincraTransactionHandler("REF-200");

            expect(fincra.verifyTransaction).toHaveBeenCalledWith("REF-200");
            expect(result).toEqual({ status: true, data: { reference: "REF-200" } });
        });
    });

    // ============ paymentFailedHandler ============

    describe("paymentFailedHandler", () => {
        it("does not throw when payment not found (caught internally)", async () => {
            prisma.payment.findUnique.mockResolvedValue(null);

            await expect(service.paymentFailedHandler("REF-MISS")).resolves.toBeUndefined();
        });

        it("does not throw for already successful payment (caught internally)", async () => {
            prisma.payment.findUnique.mockResolvedValue({
                reference: "REF-DUP",
                paymentStatus: TransactionStatus.SUCCESS,
            });

            await expect(service.paymentFailedHandler("REF-DUP")).resolves.toBeUndefined();
        });

        it("marks payment and order as failed", async () => {
            prisma.payment.findUnique.mockResolvedValue({
                reference: "REF-F",
                paymentStatus: TransactionStatus.PENDING,
                orderId: 100,
            });

            await service.paymentFailedHandler("REF-F");

            expect(prisma.payment.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        status: TransactionStatus.FAILED,
                        paymentStatus: TransactionStatus.FAILED,
                    }),
                }),
            );
            expect(prisma.order.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 100 },
                    data: expect.objectContaining({
                        paymentStatus: TransactionStatus.FAILED,
                    }),
                }),
            );
        });
    });

    // ============ paymentAbandonedHandler ============

    describe("paymentAbandonedHandler", () => {
        it("marks payment as abandoned and order as failed", async () => {
            prisma.payment.findUnique.mockResolvedValue({
                reference: "REF-AB",
                paymentStatus: TransactionStatus.PENDING,
                orderId: 200,
            });

            await service.paymentAbandonedHandler("REF-AB");

            expect(prisma.payment.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        paymentStatus: TransactionStatus.ABANDONED,
                    }),
                }),
            );
            expect(prisma.order.update).toHaveBeenCalled();
        });
    });

    // ============ paymentSuccessHandler ============

    describe("paymentSuccessHandler", () => {
        it("throws when payment not found", async () => {
            prisma.payment.findUnique.mockResolvedValue(null);

            await expect(service.paymentSuccessHandler("REF-X")).rejects.toThrow();
        });

        it("throws for duplicate success", async () => {
            prisma.payment.findUnique.mockResolvedValue({
                reference: "REF-D",
                paymentStatus: TransactionStatus.SUCCESS,
            });

            await expect(service.paymentSuccessHandler("REF-D")).rejects.toThrow();
        });

        it("handles non-BUY order gracefully", async () => {
            prisma.payment.findUnique.mockResolvedValue({
                reference: "REF-NB",
                paymentStatus: TransactionStatus.PENDING,
                orderId: 300,
            });
            prisma.user.findFirst.mockResolvedValue({ id: 99 });
            prisma.order.findUnique.mockResolvedValue({
                id: 300,
                orderCategory: OrderCategory.SELL,
                user: { id: 5, email: "u@x.com" },
                transactionId: "TXN-300",
                amount: 1,
                currency: "BTC",
                createdAt: new Date(),
            });

            await service.paymentSuccessHandler("REF-NB");

            expect(prisma.order.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        status: OrderStatus.confirmed,
                        streamlinedStatus: OrderStreamlinedStatus.completed,
                    }),
                }),
            );
            expect(ws.notifyTransactionUpdate).toHaveBeenCalled();
        });

        it("initiates crypto withdrawal for BUY order", async () => {
            prisma.payment.findUnique.mockResolvedValue({
                reference: "REF-BUY",
                paymentStatus: TransactionStatus.PENDING,
                orderId: 400,
            });
            prisma.user.findFirst.mockResolvedValue({ id: 99 });
            prisma.order.findUnique.mockResolvedValue({
                id: 400,
                orderCategory: OrderCategory.BUY,
                user: { id: 10, email: "buyer@x.com" },
                transactionId: "TXN-400",
                amount: 0.5,
                currency: "ETH",
                recipient: "0xABC",
                destinationTag: null,
                createdAt: new Date(),
            });
            quidax.createWithdrawerRequest.mockResolvedValue({
                data: {
                    id: "Q-1",
                    currency: "eth",
                    amount: "0.5",
                    fee: "0.001",
                    total: "0.501",
                    narration: "flipxer buy order 400",
                    type: "crypto",
                    recipient: { details: { address: "0xABC" } },
                },
            });
            quidax.getSingleMarketTicker.mockResolvedValue({
                data: { ticker: { buy: "5000000" } },
            });

            await service.paymentSuccessHandler("REF-BUY");

            expect(quidax.createWithdrawerRequest).toHaveBeenCalled();
            expect(prisma.order.create).toHaveBeenCalled(); // admin SELL order
        });

        it("marks order failed and re-throws when Quidax withdrawal fails", async () => {
            prisma.payment.findUnique.mockResolvedValue({
                reference: "REF-WFAIL",
                paymentStatus: TransactionStatus.PENDING,
                orderId: 500,
            });
            prisma.user.findFirst.mockResolvedValue({ id: 99 });
            prisma.order.findUnique.mockResolvedValue({
                id: 500,
                orderCategory: OrderCategory.BUY,
                user: { id: 11, email: "b@x.com" },
                transactionId: "TXN-500",
                amount: 1,
                currency: "BTC",
                recipient: "0xDEF",
                destinationTag: null,
                createdAt: new Date(),
            });
            quidax.createWithdrawerRequest.mockRejectedValue(new Error("quidax timeout"));

            await expect(service.paymentSuccessHandler("REF-WFAIL")).rejects.toThrow("quidax timeout");

            expect(prisma.order.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        status: OrderStatus.failed,
                        streamlinedStatus: OrderStreamlinedStatus.failed,
                    }),
                }),
            );
            expect(ws.notifyTransactionUpdate).toHaveBeenCalledTimes(2); // processing + failure
        });
    });

    // ============ processAssetValueTransferToBankHandler ============

    describe("processAssetValueTransferToBankHandler", () => {
        it("does nothing when payment not found (caught internally)", async () => {
            prisma.payment.findUnique.mockResolvedValue(null);

            await expect(
                service.processAssetValueTransferToBankHandler({
                    paymentReference: "REF-MISS",
                    transferToBankStatus: TransactionStatus.SUCCESS as any,
                }),
            ).resolves.toBeUndefined();
        });

        it("sends notification on successful transfer", async () => {
            prisma.payment.findUnique.mockResolvedValue({
                reference: "REF-SELL",
                paymentStatus: TransactionStatus.PENDING,
                userId: 7,
                amount: 50000,
                transactionId: "TXN-SELL",
                destinationBankAccountName: "GT",
                destinationBankAccountNumber: "0001234567",
            });
            prisma.user.findUnique.mockResolvedValue({ id: 7, email: "sell@x.com" });

            await service.processAssetValueTransferToBankHandler({
                paymentReference: "REF-SELL",
                transferToBankStatus: TransactionStatus.SUCCESS as any,
            });

            expect(notifDispatcher.notify).toHaveBeenCalledWith(
                expect.objectContaining({ userId: 7 }),
            );
        });
    });

    // ============ getAmountInNaira ============

    describe("getAmountInNaira", () => {
        it("returns null when no ticker data", async () => {
            quidax.getSingleMarketTicker.mockResolvedValue({ data: null });

            const result = await service.getAmountInNaira("BTC", 1);

            expect(result).toBeNull();
        });

        it("returns null when rate is NaN", async () => {
            quidax.getSingleMarketTicker.mockResolvedValue({
                data: { ticker: { buy: "not-a-number" } },
            });

            const result = await service.getAmountInNaira("ETH", 1, "buy");

            expect(result).toBeNull();
        });

        it("returns converted fiat amount", async () => {
            quidax.getSingleMarketTicker.mockResolvedValue({
                data: { ticker: { buy: "5000000" } },
            });

            const result = await service.getAmountInNaira("BTC", 2, "buy");

            expect(result).toEqual({ amount: 10_000_000, rate: 5_000_000 });
        });
    });
});
