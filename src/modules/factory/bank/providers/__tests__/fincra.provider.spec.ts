jest.mock("@/utils", () => ({
    generateId: jest.fn(({ type }: { type: string }) => {
        if (type === "reference") return "f-ref-123";
        if (type === "transaction") return "f-trx-123";
        if (type === "sessionId") return "f-sess-123";
        return "f-id-123";
    }),
}));

jest.mock("@/config", () => ({
    fincraOptions: {
        redirectUrl: "https://flipxer.app/callback",
        businessId: "biz-001",
    },
}));

import { FincraBank } from "../fincra.provider";
import * as errors from "../../errors/fincra.error";

describe("FincraBank", () => {
    const fincra = {
        getBanks: jest.fn(),
        resolveBankAccount: jest.fn(),
        initializeCheckout: jest.fn(),
        verifyPayment: jest.fn(),
        initiateBankTransfer: jest.fn(),
        verifyPayoutByCustomerReference: jest.fn(),
        getWallets: jest.fn(),
    };

    const prisma = {
        payment: {
            create: jest.fn(),
        },
        $transaction: jest.fn(),
    };

    let provider: FincraBank;

    beforeEach(() => {
        jest.clearAllMocks();
        provider = new FincraBank(fincra as never, prisma as never);
    });

    it("getBanks returns provider response", async () => {
        fincra.getBanks.mockResolvedValue({ success: true, data: [{ code: "058" }] });

        const result = await provider.getBanks();

        expect(fincra.getBanks).toHaveBeenCalledWith("NG");
        expect(result.success).toBe(true);
    });

    it("resolveBankAccount handles snake_case payload", async () => {
        fincra.resolveBankAccount.mockResolvedValue({
            success: true,
            data: {
                account_number: "0011223344",
                account_name: "Jane Doe",
                bank_code: "033",
            },
        });

        const result = await provider.resolveBankAccount({
            account_number: "0011223344",
            bank_code: "033",
        });

        expect(result).toEqual({
            status: true,
            data: {
                accountNumber: "0011223344",
                accountName: "Jane Doe",
                bankCode: "033",
            },
        });
    });

    it("resolveBankAccount throws FINCRABankException when response is invalid", async () => {
        fincra.resolveBankAccount.mockResolvedValue({ success: true, data: null });

        await expect(
            provider.resolveBankAccount({ account_number: "1", bank_code: "2" }),
        ).rejects.toBeInstanceOf(errors.FINCRABankException);
    });

    it("initializePayment returns checkout link and generated reference", async () => {
        fincra.initializeCheckout.mockResolvedValue({
            status: true,
            message: "ok",
            data: {
                link: "https://checkout.fincra.com/pay",
            },
        });

        const result = await provider.initializePayment(
            {
                id: 99,
                firstName: "Flip",
                lastName: "Xer",
                email: "pay@flipxer.com",
                phoneNumber: "+2348000000000",
            } as never,
            12000,
        );

        expect(result.status).toBe(true);
        expect(result.data.link).toBe("https://checkout.fincra.com/pay");
        expect(result.data.reference).toBe("f-ref-123");
    });

    it("verifyTransferStatus maps provider statuses", async () => {
        fincra.verifyPayoutByCustomerReference
            .mockResolvedValueOnce({ data: { status: "successful" } })
            .mockResolvedValueOnce({ data: { status: "failed" } })
            .mockResolvedValueOnce({ data: { status: "processing" } });

        const success = await provider.verifyTransferStatus("ref-1");
        const failed = await provider.verifyTransferStatus("ref-2");
        const pending = await provider.verifyTransferStatus("ref-3");

        expect(success.status).toBe("success");
        expect(failed.status).toBe("failed");
        expect(pending.status).toBe("pending");
    });

    it("initializeTransfer creates payment and calls fincra transfer", async () => {
        jest.spyOn(provider, "resolveBankAccount").mockResolvedValue({
            status: true,
            data: {
                accountNumber: "1234567890",
                accountName: "Transfer User",
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
            userId: 1,
            orderId: 2,
            amount: 2000,
            serviceCharge: 50,
            accountNumber: "1234567890",
            accountName: "Transfer User",
            bankName: "UBA",
            bankCode: "058",
            reference: "tr-ref-1",
            senderName: "Flipxer Sender",
            senderEmail: "sender@flipxer.com",
        } as never);

        expect(paymentCreate).toHaveBeenCalledTimes(1);
        expect(fincra.initiateBankTransfer).toHaveBeenCalledWith(
            expect.objectContaining({
                amount: 2000,
                customerReference: "tr-ref-1",
                destinationCurrency: "NGN",
            }),
        );
    });

    it("recordIncomingPayment stores pending fincra payment", async () => {
        prisma.payment.create.mockResolvedValue({ id: 10 });

        await provider.recordIncomingPayment({
            userId: 21,
            amount: 4500,
            reference: "f-pay-ref",
            orderId: 7,
        });

        expect(prisma.payment.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    userId: 21,
                    amount: 4500,
                    reference: "f-pay-ref",
                }),
            }),
        );
    });

    it("getWallets returns wallet balances on success", async () => {
        fincra.getWallets.mockResolvedValue({
            status: true,
            data: [{ currency: "NGN", availableBalance: 100000 }],
        });

        const result = await provider.getWallets();

        expect(result.status).toBe(true);
        expect(result.data).toHaveLength(1);
    });

    it("getWallets throws FINCRABankException when status is falsy", async () => {
        fincra.getWallets.mockResolvedValue({ status: false });

        await expect(provider.getWallets()).rejects.toBeInstanceOf(errors.FINCRABankException);
    });

    it("getWallets throws FINCRABankException on network error", async () => {
        fincra.getWallets.mockRejectedValue(new Error("timeout"));

        await expect(provider.getWallets()).rejects.toBeInstanceOf(errors.FINCRABankException);
    });
});
