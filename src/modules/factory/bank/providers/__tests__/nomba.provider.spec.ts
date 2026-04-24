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
        getVirtualAccount: jest.fn(),
        updateVirtualAccount: jest.fn(),
        deleteVirtualAccount: jest.fn(),
        createCheckoutOrder: jest.fn(),
        getCheckoutStatus: jest.fn(),
        initiateBankTransfer: jest.fn(),
        getTransferByMerchantRef: jest.fn(),
        getAccountBalance: jest.fn(),
        isSandbox: false,
    };

    const prisma = {
        payment: {
            create: jest.fn(),
            updateMany: jest.fn(),
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

        prisma.payment.create.mockResolvedValue(undefined);

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

        expect(prisma.payment.create).toHaveBeenCalledTimes(1);
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

    // ─── getBanks edge cases ───────────────────────────────────────────────────

    it("getBanks wraps network error in NOMBABankException", async () => {
        nomba.getBanks.mockRejectedValue(new Error("timeout"));

        await expect(provider.getBanks()).rejects.toBeInstanceOf(errors.NOMBABankException);
    });

    it("getBanks rethrows NOMBABankException without wrapping", async () => {
        const original = new errors.NOMBABankException("already bank");
        nomba.getBanks.mockRejectedValue(original);

        await expect(provider.getBanks()).rejects.toBe(original);
    });

    // ─── resolveBankAccount edge cases ────────────────────────────────────────

    it("resolveBankAccount throws NOMBABankException when code is not 00", async () => {
        nomba.lookupBankAccount.mockResolvedValue({
            code: "02",
            description: "Account not found",
        });

        await expect(
            provider.resolveBankAccount({ account_number: "0000000000", bank_code: "058" }),
        ).rejects.toBeInstanceOf(errors.NOMBABankException);
    });

    it("resolveBankAccount throws when accountNumber is missing from response data", async () => {
        nomba.lookupBankAccount.mockResolvedValue({
            code: "00",
            data: { accountName: "John Doe", bankCode: "058" }, // no accountNumber
        });

        await expect(
            provider.resolveBankAccount({ account_number: "0123456789", bank_code: "058" }),
        ).rejects.toBeInstanceOf(errors.NOMBABankException);
    });

    it("resolveBankAccount throws when accountName is missing from response data", async () => {
        nomba.lookupBankAccount.mockResolvedValue({
            code: "00",
            data: { accountNumber: "0123456789", bankCode: "058" }, // no accountName
        });

        await expect(
            provider.resolveBankAccount({ account_number: "0123456789", bank_code: "058" }),
        ).rejects.toBeInstanceOf(errors.NOMBABankException);
    });

    it("resolveBankAccount wraps network error in NOMBABankException", async () => {
        nomba.lookupBankAccount.mockRejectedValue(new Error("socket hang up"));

        await expect(
            provider.resolveBankAccount({ account_number: "0123456789", bank_code: "058" }),
        ).rejects.toBeInstanceOf(errors.NOMBABankException);
    });

    // ─── createVirtualAccount edge cases ──────────────────────────────────────

    it("createVirtualAccount returns data on success", async () => {
        nomba.createVirtualAccount.mockResolvedValue({
            code: "00",
            data: { bankAccountNumber: "9876543210", bankAccountName: "Flip Xer", bankName: "Nomba" },
        });

        const result = await provider.createVirtualAccount({ id: 7, firstName: "Flip", lastName: "Xer" } as never);

        expect(result.status).toBe(true);
        expect(result.data.bankAccountNumber).toBe("9876543210");
    });

    it("createVirtualAccount uses provided accountRef from options", async () => {
        nomba.createVirtualAccount.mockResolvedValue({
            code: "00",
            data: { bankAccountNumber: "1111111111", bankAccountName: "Flip Xer" },
        });

        await provider.createVirtualAccount(
            { id: 7, firstName: "Flip", lastName: "Xer" } as never,
            { accountRef: "custom-ref-99" },
        );

        expect(nomba.createVirtualAccount).toHaveBeenCalledWith(
            expect.objectContaining({ accountRef: "custom-ref-99" }),
        );
    });

    it("createVirtualAccount throws NombaVirtualAccountException when code is not 00", async () => {
        nomba.createVirtualAccount.mockResolvedValue({ code: "01", description: "limit exceeded" });

        await expect(
            provider.createVirtualAccount({ id: 7, firstName: "Flip", lastName: "Xer" } as never),
        ).rejects.toBeInstanceOf(errors.NombaVirtualAccountException);
    });

    it("createVirtualAccount wraps network error in NombaVirtualAccountException", async () => {
        nomba.createVirtualAccount.mockRejectedValue(new Error("downstream unavailable"));

        await expect(
            provider.createVirtualAccount({ id: 7, firstName: "Flip", lastName: "Xer" } as never),
        ).rejects.toBeInstanceOf(errors.NombaVirtualAccountException);
    });

    // ─── deleteVirtualAccount edge cases ──────────────────────────────────────

    it("deleteVirtualAccount returns true on success", async () => {
        nomba.deleteVirtualAccount.mockResolvedValue(true);

        const result = await provider.deleteVirtualAccount("some-account-ref");

        expect(result).toBe(true);
        expect(nomba.deleteVirtualAccount).toHaveBeenCalledWith("some-account-ref");
    });

    it("deleteVirtualAccount returns false without throwing on error (best-effort)", async () => {
        nomba.deleteVirtualAccount.mockRejectedValue(new Error("not found"));

        const result = await provider.deleteVirtualAccount("missing-ref");

        expect(result).toBe(false);
    });

    // ─── initializePayment edge cases ─────────────────────────────────────────

    it("initializePayment throws NombaWorkflowException when code is not 00", async () => {
        nomba.createCheckoutOrder.mockResolvedValue({ code: "99", description: "service unavailable" });

        await expect(
            provider.initializePayment(
                { id: 1, email: "test@flipxer.com", firstName: "Test", lastName: "User" } as never,
                5000,
            ),
        ).rejects.toBeInstanceOf(errors.NombaWorkflowException);
    });

    it("initializePayment uses referenceOverride instead of generated reference", async () => {
        nomba.createCheckoutOrder.mockResolvedValue({
            code: "00",
            data: { checkoutLink: "https://checkout.nomba.com/xyz", orderReference: "nomba-ref", amount: 5000 },
        });

        const result = await provider.initializePayment(
            { id: 1, email: "test@flipxer.com", firstName: "Test", lastName: "User" } as never,
            5000,
            undefined,
            "override-ref-001",
        );

        expect(result.data.reference).toBe("override-ref-001");
        expect(nomba.createCheckoutOrder).toHaveBeenCalledWith(
            expect.objectContaining({ order: expect.objectContaining({ orderReference: "override-ref-001" }) }),
        );
    });

    // ─── initializePaymentViaVirtualAccount edge cases ────────────────────────

    it("initializePaymentViaVirtualAccount throws NombaWorkflowException when code is not 00", async () => {
        nomba.createVirtualAccount.mockResolvedValue({ code: "03", description: "quota exceeded" });

        await expect(
            provider.initializePaymentViaVirtualAccount(
                { id: 2, email: "u@flipxer.com", firstName: "A", lastName: "B" } as never,
                1000,
            ),
        ).rejects.toBeInstanceOf(errors.NombaWorkflowException);
    });

    it("initializePaymentViaVirtualAccount uses referenceOverride", async () => {
        nomba.createVirtualAccount.mockResolvedValue({
            code: "00",
            data: { bankAccountNumber: "2222222222", bankAccountName: "A B", bankName: "Nomba" },
        });

        const result = await provider.initializePaymentViaVirtualAccount(
            { id: 2, email: "u@flipxer.com", firstName: "A", lastName: "B" } as never,
            1000,
            "fixed-ref-007",
        );

        expect(result.data.reference).toBe("fixed-ref-007");
        expect(nomba.createVirtualAccount).toHaveBeenCalledWith(
            expect.objectContaining({ accountRef: "fixed-ref-007" }),
        );
    });

    it("initializePaymentViaVirtualAccount expiryAt is a valid ISO 8601 string", async () => {
        nomba.createVirtualAccount.mockResolvedValue({
            code: "00",
            data: { bankAccountNumber: "3333333333", bankAccountName: "Flip Xer", bankName: "Nomba" },
        });

        const before = Date.now();
        const result = await provider.initializePaymentViaVirtualAccount(
            { id: 3, email: "u@flipxer.com", firstName: "Flip", lastName: "Xer" } as never,
            2000,
            undefined,
            10,
        );
        const after = Date.now();

        const expiryMs = new Date(result.data.expiryAt).getTime();
        expect(result.data.expiryAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(expiryMs).toBeGreaterThan(before + 9 * 60 * 1000);
        expect(expiryMs).toBeLessThan(after + 11 * 60 * 1000);
    });

    it("initializePaymentViaVirtualAccount uses 'Flipxer User' as accountName when names are blank", async () => {
        nomba.createVirtualAccount.mockResolvedValue({
            code: "00",
            data: { bankAccountNumber: "4444444444", bankAccountName: "Flipxer User", bankName: "Nomba" },
        });

        await provider.initializePaymentViaVirtualAccount(
            { id: 4, email: "u@flipxer.com", firstName: "", lastName: "" } as never,
            500,
        );

        expect(nomba.createVirtualAccount).toHaveBeenCalledWith(
            expect.objectContaining({ accountName: "Flipxer User" }),
        );
    });

    // ─── verifyTransaction edge cases ─────────────────────────────────────────

    it("verifyTransaction returns data on success", async () => {
        nomba.getCheckoutStatus.mockResolvedValue({ data: { status: "PAID", amount: 5000 } });

        const result = await provider.verifyTransaction("ref-ok");

        expect(result.status).toBe(true);
        expect(result.data.status).toBe("PAID");
    });

    it("verifyTransaction throws NombaVerifyTransactionException when data is missing", async () => {
        nomba.getCheckoutStatus.mockResolvedValue({ data: null });

        await expect(provider.verifyTransaction("ref-missing")).rejects.toBeInstanceOf(
            errors.NombaVerifyTransactionException,
        );
    });

    // ─── verifyTransferStatus edge cases ──────────────────────────────────────

    it("verifyTransferStatus maps SUCCESSFUL to 'success'", async () => {
        nomba.getTransferByMerchantRef.mockResolvedValue({ data: { status: "SUCCESSFUL" } });

        const result = await provider.verifyTransferStatus("ref-successful");

        expect(result.status).toBe("success");
    });

    it("verifyTransferStatus maps PROCESSING to 'pending'", async () => {
        nomba.getTransferByMerchantRef.mockResolvedValue({ data: { status: "PROCESSING" } });

        const result = await provider.verifyTransferStatus("ref-proc");

        expect(result.status).toBe("pending");
    });

    it("verifyTransferStatus maps PENDING to 'pending'", async () => {
        nomba.getTransferByMerchantRef.mockResolvedValue({ data: { status: "PENDING" } });

        const result = await provider.verifyTransferStatus("ref-pend");

        expect(result.status).toBe("pending");
    });

    it("verifyTransferStatus maps unknown status to 'pending'", async () => {
        nomba.getTransferByMerchantRef.mockResolvedValue({ data: { status: "QUEUED" } });

        const result = await provider.verifyTransferStatus("ref-queued");

        expect(result.status).toBe("pending");
    });

    it("verifyTransferStatus throws NombaVerifyTransactionException when resp.data is missing", async () => {
        nomba.getTransferByMerchantRef.mockResolvedValue({ data: null });

        await expect(provider.verifyTransferStatus("ref-empty")).rejects.toBeInstanceOf(
            errors.NombaVerifyTransactionException,
        );
    });

    it("verifyTransferStatus throws NombaWorkflowException on network error", async () => {
        nomba.getTransferByMerchantRef.mockRejectedValue(new Error("timeout"));

        await expect(provider.verifyTransferStatus("ref-timeout")).rejects.toBeInstanceOf(
            errors.NombaWorkflowException,
        );
    });

    // ─── initializeTransfer edge cases ────────────────────────────────────────

    it("initializeTransfer propagates NOMBABankException when resolveBankAccount fails", async () => {
        jest.spyOn(provider, "resolveBankAccount").mockRejectedValue(
            new errors.NOMBABankException("account not found"),
        );

        await expect(
            provider.initializeTransfer({
                userId: 10, orderId: 20, amount: 1500, serviceCharge: 50,
                accountNumber: "0000000000", accountName: "Bad Account",
                bankName: "GTB", bankCode: "058", reference: "wd-bad",
            } as never),
        ).rejects.toBeInstanceOf(errors.NOMBABankException);
    });

    it("initializeTransfer totalAmount includes serviceCharge", async () => {
        jest.spyOn(provider, "resolveBankAccount").mockResolvedValue({
            status: true,
            data: { accountNumber: "1234567890", accountName: "Test User", bankCode: "058" },
        });

        prisma.payment.create.mockResolvedValue(undefined);
        nomba.initiateBankTransfer.mockResolvedValue(undefined);

        await provider.initializeTransfer({
            userId: 10, orderId: 20, amount: 2000, serviceCharge: 100,
            accountNumber: "1234567890", accountName: "Test User",
            bankName: "GTB", bankCode: "058", reference: "wd-total",
        } as never);

        expect(prisma.payment.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ amount: 2000, totalAmount: 2100 }),
            }),
        );
    });

    it("initializeTransfer throws NombaWorkflowException when transfer call fails", async () => {
        jest.spyOn(provider, "resolveBankAccount").mockResolvedValue({
            status: true,
            data: { accountNumber: "1234567890", accountName: "Test User", bankCode: "058" },
        });

        prisma.payment.create.mockResolvedValue(undefined);
        prisma.payment.updateMany.mockResolvedValue({ count: 1 });
        nomba.initiateBankTransfer.mockRejectedValue(new Error("Nomba downstream error"));

        await expect(
            provider.initializeTransfer({
                userId: 10, orderId: 20, amount: 1500, serviceCharge: 50,
                accountNumber: "1234567890", accountName: "Test User",
                bankName: "GTB", bankCode: "058", reference: "wd-fail",
            } as never),
        ).rejects.toBeInstanceOf(errors.NombaWorkflowException);

        // Payment should be marked as FAILED when transfer fails
        expect(prisma.payment.updateMany).toHaveBeenCalledWith({
            where: { reference: "wd-fail" },
            data: expect.objectContaining({ status: "FAILED" }),
        });
    });

    // ─── recordIncomingPayment edge cases ─────────────────────────────────────

    it("recordIncomingPayment creates record without orderId when omitted", async () => {
        prisma.payment.create.mockResolvedValue({ id: 99 });

        await provider.recordIncomingPayment({
            userId: 10,
            amount: 500,
            reference: "pay-no-order",
        });

        expect(prisma.payment.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ orderId: undefined }),
            }),
        );
    });

    it("recordIncomingPayment uses 'NGN' as default currency when not provided", async () => {
        prisma.payment.create.mockResolvedValue({ id: 100 });

        await provider.recordIncomingPayment({
            userId: 11,
            amount: 1000,
            reference: "pay-default-currency",
        });

        expect(prisma.payment.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ expectedCurrency: "NGN" }),
            }),
        );
    });

    // ─── sandbox VA fallback ──────────────────────────────────────────────────

    it("initializePaymentViaVirtualAccount falls back to PUT+GET when sandbox VA quota is hit", async () => {
        const fallbackRef = "fallback-va-ref";
        const originalEnv = process.env.NOMBA_SANDBOX_FALLBACK_VA_REF;
        process.env.NOMBA_SANDBOX_FALLBACK_VA_REF = fallbackRef;
        (nomba as any).isSandbox = true;

        nomba.createVirtualAccount.mockRejectedValue(
            new Error("Only 2 sandbox virtual accounts are allowed per account holder"),
        );
        nomba.updateVirtualAccount.mockResolvedValue({ code: "00", data: { updated: true } });
        nomba.getVirtualAccount.mockResolvedValue({
            code: "00",
            data: {
                accountRef: fallbackRef,
                bankAccountNumber: "9999999999",
                bankAccountName: "Sandbox VA",
                bankName: "Nomba Bank",
                accountName: "Sandbox VA",
                expired: false,
            },
        });

        const result = await provider.initializePaymentViaVirtualAccount(
            { id: 5, email: "u@flipxer.com", firstName: "Sand", lastName: "Box" } as never,
            7500,
        );

        expect(nomba.updateVirtualAccount).toHaveBeenCalledWith(
            fallbackRef,
            expect.objectContaining({ accountName: "Sand Box" }),
        );
        expect(nomba.getVirtualAccount).toHaveBeenCalledWith(fallbackRef);
        expect(result.status).toBe(true);
        expect(result.data.accountNumber).toBe("9999999999");

        process.env.NOMBA_SANDBOX_FALLBACK_VA_REF = originalEnv;
        (nomba as any).isSandbox = false;
    });

    it("initializePaymentViaVirtualAccount does NOT fallback when not on sandbox", async () => {
        const originalEnv = process.env.NOMBA_SANDBOX_FALLBACK_VA_REF;
        process.env.NOMBA_SANDBOX_FALLBACK_VA_REF = "some-ref";
        (nomba as any).isSandbox = false;

        nomba.createVirtualAccount.mockRejectedValue(
            new Error("Only 2 sandbox virtual accounts are allowed per account holder"),
        );

        await expect(
            provider.initializePaymentViaVirtualAccount(
                { id: 5, email: "u@flipxer.com", firstName: "A", lastName: "B" } as never,
                1000,
            ),
        ).rejects.toBeInstanceOf(errors.NombaWorkflowException);

        expect(nomba.updateVirtualAccount).not.toHaveBeenCalled();

        process.env.NOMBA_SANDBOX_FALLBACK_VA_REF = originalEnv;
    });

    it("initializePaymentViaVirtualAccount does NOT fallback when env var is unset", async () => {
        const originalEnv = process.env.NOMBA_SANDBOX_FALLBACK_VA_REF;
        delete process.env.NOMBA_SANDBOX_FALLBACK_VA_REF;
        (nomba as any).isSandbox = true;

        nomba.createVirtualAccount.mockRejectedValue(
            new Error("Only 2 sandbox virtual accounts are allowed per account holder"),
        );

        await expect(
            provider.initializePaymentViaVirtualAccount(
                { id: 5, email: "u@flipxer.com", firstName: "A", lastName: "B" } as never,
                1000,
            ),
        ).rejects.toBeInstanceOf(errors.NombaWorkflowException);

        expect(nomba.updateVirtualAccount).not.toHaveBeenCalled();

        process.env.NOMBA_SANDBOX_FALLBACK_VA_REF = originalEnv;
        (nomba as any).isSandbox = false;
    });
});
