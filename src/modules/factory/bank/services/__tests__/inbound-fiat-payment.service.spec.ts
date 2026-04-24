import { InboundFiatPaymentService } from "../inbound-fiat-payment.service";

function createFincraService() {
    return {
        initializePayment: jest.fn(),
        verifyTransaction: jest.fn(),
        resolveBankAccount: jest.fn(),
    };
}

function createNombaService() {
    return {
        initializePaymentViaVirtualAccount: jest.fn(),
        initializePayment: jest.fn(),
        verifyTransaction: jest.fn(),
        resolveBankAccount: jest.fn(),
        deleteVirtualAccount: jest.fn(),
    };
}

describe("InboundFiatPaymentService", () => {
    const user = {
        id: 42,
        firstName: "Flip",
        lastName: "Xer",
        email: "flipxer@example.com",
        phoneNumber: "+2348000000000",
    };

    let fincraService: ReturnType<typeof createFincraService>;
    let nombaService: ReturnType<typeof createNombaService>;
    let service: InboundFiatPaymentService;

    beforeEach(() => {
        jest.clearAllMocks();
        fincraService = createFincraService();
        nombaService = createNombaService();
        service = new InboundFiatPaymentService(
            fincraService as any,
            nombaService as any,
        );
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe("initializePayment", () => {
        it("rejects unsupported providers", async () => {
            await expect(
                service.initializePayment({
                    provider: "stripe" as any,
                    user,
                    amount: 1000,
                }),
            ).rejects.toThrow("Unsupported inbound payment provider: stripe");
        });

        it("returns a hosted checkout payload for fincra", async () => {
            jest.spyOn(Date, "now").mockReturnValue(new Date("2026-04-18T12:00:00.000Z").getTime());
            fincraService.initializePayment.mockResolvedValue({
                data: {
                    reference: "FIN-REF-1",
                    link: "https://checkout.fincra.com/pay",
                },
            });

            const result = await service.initializePayment({
                provider: "fincra",
                user,
                amount: 12500,
                callbackUrl: "https://flipxer.com/payments/callback",
            });

            expect(fincraService.initializePayment).toHaveBeenCalledWith(
                user,
                12500,
                "https://flipxer.com/payments/callback",
            );
            expect(result).toEqual({
                provider: "fincra",
                mode: "checkout",
                reference: "FIN-REF-1",
                amount: 12500,
                expiryAt: "2026-04-18T12:35:00.000Z",
                authorizationUrl: "https://checkout.fincra.com/pay",
            });
            expect(nombaService.initializePayment).not.toHaveBeenCalled();
        });

        it("returns a virtual account payload for nomba", async () => {
            nombaService.initializePaymentViaVirtualAccount.mockResolvedValue({
                data: {
                    reference: "NOM-VA-1",
                    accountNumber: "0123456789",
                    accountName: "Flip Xer",
                    bankName: "Nomba Bank",
                    bankCode: "999",
                    expiryAt: "2026-04-18T12:35:00.000Z",
                },
            });

            const result = await service.initializePayment({
                provider: "nomba",
                user,
                amount: 5400,
                modePreference: "virtual_account",
            });

            expect(nombaService.initializePaymentViaVirtualAccount).toHaveBeenCalledWith(
                user,
                5400,
            );
            expect(result).toEqual({
                provider: "nomba",
                mode: "virtual_account",
                reference: "NOM-VA-1",
                providerAccountReference: "NOM-VA-1",
                amount: 5400,
                expiryAt: "2026-04-18T12:35:00.000Z",
                accountNumber: "0123456789",
                accountName: "Flip Xer",
                bankName: "Nomba Bank",
                bankCode: "999",
            });
            expect(nombaService.initializePayment).not.toHaveBeenCalled();
        });

        it("falls back to hosted checkout when the nomba sandbox virtual account cap is reached", async () => {
            jest.spyOn(Date, "now").mockReturnValue(new Date("2026-04-18T09:00:00.000Z").getTime());
            const warnSpy = jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);

            nombaService.initializePaymentViaVirtualAccount.mockRejectedValue(
                new Error("Only 2 sandbox virtual accounts are allowed per account holder"),
            );
            nombaService.initializePayment.mockResolvedValue({
                data: {
                    reference: "NOM-CHK-1",
                    link: "https://checkout.nomba.com/pay",
                },
            });

            const result = await service.initializePayment({
                provider: "nomba",
                user,
                amount: 9100,
                callbackUrl: "https://flipxer.com/checkout/callback",
                modePreference: "virtual_account",
            });

            expect(warnSpy).toHaveBeenCalledWith(
                "Nomba sandbox virtual account cap reached for user 42; falling back to hosted checkout",
            );
            expect(nombaService.initializePayment).toHaveBeenCalledWith(
                user,
                9100,
                "https://flipxer.com/checkout/callback",
            );
            expect(result).toEqual({
                provider: "nomba",
                mode: "checkout",
                reference: "NOM-CHK-1",
                amount: 9100,
                expiryAt: "2026-04-18T09:35:00.000Z",
                authorizationUrl: "https://checkout.nomba.com/pay",
            });
        });

        it("uses the provider amount when nomba checkout returns one", async () => {
            jest.spyOn(Date, "now").mockReturnValue(new Date("2026-04-18T10:00:00.000Z").getTime());
            nombaService.initializePayment.mockResolvedValue({
                data: {
                    reference: "NOM-CHK-2",
                    amount: "9300",
                    link: "https://checkout.nomba.com/pay-2",
                },
            });

            const result = await service.initializePayment({
                provider: "nomba",
                user,
                amount: 9000,
                modePreference: "checkout",
            });

            expect(nombaService.initializePaymentViaVirtualAccount).not.toHaveBeenCalled();
            expect(result).toEqual({
                provider: "nomba",
                mode: "checkout",
                reference: "NOM-CHK-2",
                amount: 9300,
                expiryAt: "2026-04-18T10:35:00.000Z",
                authorizationUrl: "https://checkout.nomba.com/pay-2",
            });
        });

        it("rethrows the virtual account error when checkout fallback is disabled", async () => {
            const limitError = new Error(
                "Only 2 sandbox virtual accounts are allowed per account holder",
            );
            nombaService.initializePaymentViaVirtualAccount.mockRejectedValue(limitError);

            await expect(
                service.initializePayment({
                    provider: "nomba",
                    user,
                    amount: 5400,
                    modePreference: "virtual_account",
                    allowCheckoutFallback: false,
                }),
            ).rejects.toBe(limitError);

            expect(nombaService.initializePayment).not.toHaveBeenCalled();
        });

        it("rethrows unexpected nomba virtual account errors", async () => {
            const providerError = new Error("nomba timeout");
            nombaService.initializePaymentViaVirtualAccount.mockRejectedValue(providerError);

            await expect(
                service.initializePayment({
                    provider: "nomba",
                    user,
                    amount: 5400,
                    modePreference: "virtual_account",
                }),
            ).rejects.toBe(providerError);

            expect(nombaService.initializePayment).not.toHaveBeenCalled();
        });
    });

    describe("verifyCheckout", () => {
        it("routes checkout verification to fincra", async () => {
            fincraService.verifyTransaction.mockResolvedValue({
                data: { status: "successful", reference: "FIN-VERIFY" },
            });

            const result = await service.verifyCheckout({
                provider: "fincra",
                reference: "FIN-VERIFY",
            });

            expect(fincraService.verifyTransaction).toHaveBeenCalledWith("FIN-VERIFY");
            expect(result).toEqual({
                provider: "fincra",
                data: { status: "successful", reference: "FIN-VERIFY" },
            });
        });

        it("routes checkout verification to nomba", async () => {
            nombaService.verifyTransaction.mockResolvedValue({
                data: { status: "successful", orderReference: "NOM-VERIFY" },
            });

            const result = await service.verifyCheckout({
                provider: "nomba",
                reference: "NOM-VERIFY",
            });

            expect(nombaService.verifyTransaction).toHaveBeenCalledWith("NOM-VERIFY");
            expect(result).toEqual({
                provider: "nomba",
                data: { status: "successful", orderReference: "NOM-VERIFY" },
            });
        });

        it("rejects unsupported providers during checkout verification", async () => {
            await expect(
                service.verifyCheckout({
                    provider: "stripe" as any,
                    reference: "BAD-VERIFY",
                }),
            ).rejects.toThrow("Unsupported inbound payment provider: stripe");
        });
    });

    describe("resolveBankAccount", () => {
        it("routes bank account resolution to fincra", async () => {
            fincraService.resolveBankAccount.mockResolvedValue({
                data: {
                    accountName: "Fincra User",
                    accountNumber: "0011223344",
                    bankCode: "058",
                },
            });

            const result = await service.resolveBankAccount({
                provider: "fincra",
                accountNumber: "0011223344",
                bankCode: "058",
            });

            expect(fincraService.resolveBankAccount).toHaveBeenCalledWith({
                account_number: "0011223344",
                bank_code: "058",
            });
            expect(result).toEqual({
                provider: "fincra",
                accountName: "Fincra User",
                accountNumber: "0011223344",
                bankCode: "058",
            });
        });

        it("routes bank account resolution to nomba", async () => {
            nombaService.resolveBankAccount.mockResolvedValue({
                data: {
                    accountName: "Nomba User",
                    accountNumber: "0099887766",
                    bankCode: "044",
                },
            });

            const result = await service.resolveBankAccount({
                provider: "nomba",
                accountNumber: "0099887766",
                bankCode: "044",
            });

            expect(nombaService.resolveBankAccount).toHaveBeenCalledWith({
                account_number: "0099887766",
                bank_code: "044",
            });
            expect(result).toEqual({
                provider: "nomba",
                accountName: "Nomba User",
                accountNumber: "0099887766",
                bankCode: "044",
            });
        });

        it("rejects unsupported providers during bank account resolution", async () => {
            await expect(
                service.resolveBankAccount({
                    provider: "stripe" as any,
                    accountNumber: "0000000000",
                    bankCode: "999",
                }),
            ).rejects.toThrow("Unsupported inbound payment provider: stripe");
        });
    });

    describe("cleanupPendingPayment", () => {
        it("rejects unsupported providers during cleanup", async () => {
            await expect(
                service.cleanupPendingPayment({
                    provider: "stripe" as any,
                    reference: "bad-ref",
                }),
            ).rejects.toThrow("Unsupported inbound payment provider: stripe");
        });

        it("skips cleanup for fincra payments", async () => {
            await expect(
                service.cleanupPendingPayment({
                    provider: "fincra",
                    reference: "FIN-REF-1",
                }),
            ).resolves.toBe(false);

            expect(nombaService.deleteVirtualAccount).not.toHaveBeenCalled();
        });

        it("delegates cleanup to nomba virtual account deletion", async () => {
            nombaService.deleteVirtualAccount.mockResolvedValue(true);

            await expect(
                service.cleanupPendingPayment({
                    provider: "nomba",
                    reference: "NOM-REF-1",
                }),
            ).resolves.toBe(true);

            expect(nombaService.deleteVirtualAccount).toHaveBeenCalledWith("NOM-REF-1");
        });
    });
});