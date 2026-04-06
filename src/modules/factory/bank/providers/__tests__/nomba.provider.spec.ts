jest.mock("@/utils", () => ({
    generateId: jest.fn(({ type }: { type: string }) => {
        if (type === "reference") return "ref-123";
        if (type === "transaction") return "trx-123";
        if (type === "sessionId") return "sess-123";
        return "id-123";
    }),
}));

import { NombaBank } from "../nomba.provider";
import * as errors from "../../errors/nomba.error";

describe("NombaBank", () => {
    const nomba = {
        getBanks: jest.fn(),
        lookupBankAccount: jest.fn(),
        createVirtualAccount: jest.fn(),
        createCheckoutOrder: jest.fn(),
        getCheckoutStatus: jest.fn(),
        initiateBankTransfer: jest.fn(),
        getTransferByMerchantRef: jest.fn(),
        getAccountBalance: jest.fn(),
    };

    const prisma = {
        payment: {
            create: jest.fn(),
        },
        $transaction: jest.fn(),
    };

    let provider: NombaBank;

    beforeEach(() => {
        jest.clearAllMocks();
        provider = new NombaBank(nomba as never, prisma as never);
    });

    it("getBanks returns response when provider succeeds", async () => {
        nomba.getBanks.mockResolvedValue({ code: "00", data: [{ bankCode: "058" }] });

        const result = await provider.getBanks();

        expect(result.code).toBe("00");
        expect(nomba.getBanks).toHaveBeenCalledTimes(1);
    });

    it("getBanks throws NOMBABankException when code is not 00", async () => {
        nomba.getBanks.mockResolvedValue({ code: "99", description: "bad" });

        await expect(provider.getBanks()).rejects.toBeInstanceOf(errors.NOMBABankException);
    });

    it("resolveBankAccount maps account data", async () => {
        nomba.lookupBankAccount.mockResolvedValue({
            code: "00",
            data: {
                accountNumber: "0123456789",
                accountName: "John Doe",
                bankCode: "058",
            },
        });

        const result = await provider.resolveBankAccount({
            account_number: "0123456789",
            bank_code: "058",
        });

        expect(result).toEqual({
            status: true,
            data: {
                accountNumber: "0123456789",
                accountName: "John Doe",
                bankCode: "058",
            },
        });
    });

    it("initializePayment returns local reference even if provider returns another", async () => {
        nomba.createCheckoutOrder.mockResolvedValue({
            code: "00",
            data: {
                checkoutLink: "https://checkout.nomba.com/abc",
                orderReference: "provider-ref",
                amount: 5000,
            },
        });

        const result = await provider.initializePayment(
            {
                id: 1,
                email: "test@flipxer.com",
                firstName: "Test",
                lastName: "User",
            } as never,
            5000,
            "https://callback.example",
        );

        expect(result.status).toBe(true);
        expect(result.data.link).toBe("https://checkout.nomba.com/abc");
        expect(result.data.reference).toBe("ref-123");
    });

    it("initializePaymentViaVirtualAccount returns account details and expiry", async () => {
        nomba.createVirtualAccount.mockResolvedValue({
            code: "00",
            data: {
                bankAccountNumber: "1234567890",
                bankAccountName: "Flipxer User",
                bankName: "Nomba Bank",
            },
        });

        const result = await provider.initializePaymentViaVirtualAccount(
            {
                id: 1,
                email: "user@flipxer.com",
                firstName: "Flip",
                lastName: "Xer",
            } as never,
            10000,
            undefined,
            15,
        );

        expect(result.status).toBe(true);
        expect(result.data.accountNumber).toBe("1234567890");
        expect(result.data.bankCode).toBe("");
        expect(result.data.reference).toBe("ref-123");
        expect(typeof result.data.expiryAt).toBe("string");
    });

    it("verifyTransferStatus maps SUCCESS and FAILED to expected statuses", async () => {
        nomba.getTransferByMerchantRef
            .mockResolvedValueOnce({ data: { status: "SUCCESS" } })
            .mockResolvedValueOnce({ data: { status: "FAILED" } });

        const success = await provider.verifyTransferStatus("ref-1");
        const failed = await provider.verifyTransferStatus("ref-2");

        expect(success.status).toBe("success");
        expect(failed.status).toBe("failed");
    });

    it("initializeTransfer creates payment and initiates transfer", async () => {
        jest.spyOn(provider, "resolveBankAccount").mockResolvedValue({
            status: true,
            data: {
                accountNumber: "1234567890",
                accountName: "Test User",
                bankCode: "058",
            },
        });

        const paymentCreate = jest.fn().mockResolvedValue(undefined);
        prisma.$transaction.mockImplementation(async (cb: any) =>
            cb({
                payment: {
                    create: paymentCreate,
                },
            }),
        );

        await provider.initializeTransfer({
            userId: 10,
            orderId: 20,
            amount: 1500,
            serviceCharge: 50,
            accountNumber: "1234567890",
            accountName: "Test User",
            bankName: "GTB",
            bankCode: "058",
            reference: "wd-ref-1",
            narration: "withdraw",
            senderName: "Flipxer",
        } as never);

        expect(paymentCreate).toHaveBeenCalledTimes(1);
        expect(nomba.initiateBankTransfer).toHaveBeenCalledWith(
            expect.objectContaining({
                amount: 1500,
                accountNumber: "1234567890",
                merchantTxRef: "wd-ref-1",
            }),
        );
    });

    it("recordIncomingPayment creates pending payment record", async () => {
        prisma.payment.create.mockResolvedValue({ id: 1 });

        await provider.recordIncomingPayment({
            userId: 45,
            amount: 3000,
            reference: "pay-ref-1",
            orderId: 98,
            currency: "NGN",
        });

        expect(prisma.payment.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    userId: 45,
                    amount: 3000,
                    reference: "pay-ref-1",
                }),
            }),
        );
    });

    it("getAccountBalance returns balance on success", async () => {
        nomba.getAccountBalance.mockResolvedValue({
            code: "00",
            data: { amount: "250000", currency: "NGN", timeCreated: "2026-01-01T00:00:00.000Z" },
        });

        const result = await provider.getAccountBalance();

        expect(result.code).toBe("00");
        expect(result.data.amount).toBe("250000");
    });

    it("getAccountBalance throws NOMBABankException when code is not 00", async () => {
        nomba.getAccountBalance.mockResolvedValue({ code: "99", description: "fail" });

        await expect(provider.getAccountBalance()).rejects.toBeInstanceOf(errors.NOMBABankException);
    });

    it("getAccountBalance throws NOMBABankException on network error", async () => {
        nomba.getAccountBalance.mockRejectedValue(new Error("connection refused"));

        await expect(provider.getAccountBalance()).rejects.toBeInstanceOf(errors.NOMBABankException);
    });
});
