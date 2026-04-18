const mockAxiosInstance = jest.fn();
const mockCreate = jest.fn(() => mockAxiosInstance);
const mockIsAxiosError = jest.fn((error: unknown) => Boolean((error as any)?.isAxios));
const mockProxyAgent = jest.fn((proxyUrl: string) => ({ proxyUrl }));

jest.mock("axios", () => {
    const axiosDefault: any = jest.fn();
    axiosDefault.create = mockCreate;
    axiosDefault.isAxiosError = mockIsAxiosError;

    return {
        __esModule: true,
        default: axiosDefault,
        create: mockCreate,
        isAxiosError: mockIsAxiosError,
    };
});

jest.mock("https-proxy-agent", () => ({
    HttpsProxyAgent: mockProxyAgent,
}));

import { FincraLib } from "../index";

describe("FincraLib", () => {
    const baseOptions = {
        baseUrl: "https://api.fincra.com",
        secretKey: "secret-key",
        publicKey: "public-key",
        businessId: "biz-1",
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("should create axios instance with proxy agent when proxy URL is provided", () => {
        const lib = new FincraLib({
            ...baseOptions,
            proxyUrl: "https://proxy.internal:443",
        });

        expect(lib).toBeDefined();

        expect(mockProxyAgent).toHaveBeenCalledWith("https://proxy.internal:443");
        expect(mockCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                baseURL: "https://api.fincra.com",
                proxy: false,
                httpsAgent: { proxyUrl: "https://proxy.internal:443" },
            }),
        );
    });

    it("should initialize checkout", async () => {
        mockAxiosInstance.mockResolvedValue({
            data: { status: true, message: "ok", data: { link: "x", reference: "ref", payCode: "pc" } },
        });

        const lib = new FincraLib(baseOptions);
        const payload = {
            amount: 1000,
            currency: "NGN",
            reference: "ref-123",
            customer: { name: "Test User", email: "test@example.com" },
        };

        const result = await lib.initializeCheckout(payload as any);

        expect(result?.status).toBe(true);
        expect(mockAxiosInstance).toHaveBeenCalledWith(
            expect.objectContaining({
                method: "POST",
                url: "/checkout/payments",
                data: payload,
            }),
        );
    });

    it("should verify payment with business header", async () => {
        mockAxiosInstance.mockResolvedValue({
            data: { status: true, message: "ok", data: { status: "success", reference: "r", amount: 1000, currency: "NGN" } },
        });

        const lib = new FincraLib(baseOptions);
        await lib.verifyPayment("merchant-ref");

        expect(mockAxiosInstance).toHaveBeenCalledWith(
            expect.objectContaining({
                method: "GET",
                url: "/checkout/payments/merchant-reference/merchant-ref",
                headers: { "x-business-id": "biz-1" },
            }),
        );
    });

    it("should verify payment without business header when businessId is missing", async () => {
        mockAxiosInstance.mockResolvedValue({
            data: { status: true, message: "ok", data: { status: "success", reference: "r2", amount: 500, currency: "NGN" } },
        });

        const lib = new FincraLib({
            baseUrl: "https://api.fincra.com",
            secretKey: "secret-key",
            publicKey: "public-key",
        });
        await lib.verifyPayment("merchant-ref-2");

        expect(mockAxiosInstance).toHaveBeenCalledWith(
            expect.objectContaining({
                method: "GET",
                url: "/checkout/payments/merchant-reference/merchant-ref-2",
                headers: undefined,
            }),
        );
    });

    it("should reject invalid reference path segments before verifying payment", async () => {
        const lib = new FincraLib(baseOptions);

        await expect(lib.verifyPayment("../bad-ref")).rejects.toThrow("Invalid reference");
        expect(mockAxiosInstance).not.toHaveBeenCalled();
    });

    it("should fetch banks with default and custom country mapping", async () => {
        mockAxiosInstance.mockResolvedValue({ data: { success: true, message: "ok", data: [] } });

        const lib = new FincraLib(baseOptions);
        await lib.getBanks();
        await lib.getBanks("GH");

        expect(mockAxiosInstance).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                method: "GET",
                url: "/core/banks",
                params: { currency: "NGN" },
            }),
        );
        expect(mockAxiosInstance).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                method: "GET",
                url: "/core/banks",
                params: { currency: "GH" },
            }),
        );
    });

    it("should resolve bank account with defaults", async () => {
        mockAxiosInstance.mockResolvedValue({
            data: { success: true, message: "ok", data: { accountNumber: "0123", accountName: "Test", bankCode: "001" } },
        });

        const lib = new FincraLib(baseOptions);
        await lib.resolveBankAccount({ accountNumber: "0123", bankCode: "001" });

        expect(mockAxiosInstance).toHaveBeenCalledWith(
            expect.objectContaining({
                method: "POST",
                url: "/core/accounts/resolve",
                data: {
                    accountNumber: "0123",
                    bankCode: "001",
                    currency: "NGN",
                    type: "nuban",
                },
            }),
        );
    });

    it("should initiate bank transfer and fallback business ID from options", async () => {
        mockAxiosInstance.mockResolvedValue({
            data: { success: true, message: "ok", data: { id: "1", reference: "r1", status: "processing", amount: 1000, fee: 10, currency: "NGN" } },
        });

        const lib = new FincraLib(baseOptions);
        await lib.initiateBankTransfer({
            amount: 1000,
            business: undefined as any,
            sourceCurrency: "NGN",
            destinationCurrency: "NGN",
            description: "Payout",
            paymentDestination: "bank_account",
            customerReference: "cust-ref",
            beneficiary: {
                firstName: "Test",
                lastName: "User",
                accountHolderName: "Test User",
                accountNumber: "0123456789",
                bankCode: "001",
                type: "individual",
            },
        });

        expect(mockAxiosInstance).toHaveBeenCalledWith(
            expect.objectContaining({
                method: "POST",
                url: "/disbursements/payouts",
                data: expect.objectContaining({ business: "biz-1" }),
            }),
        );
    });

    it("should map axios errors to Error with status", async () => {
        mockAxiosInstance.mockRejectedValue({
            isAxios: true,
            response: {
                status: 400,
                data: { message: "invalid request" },
            },
            message: "request failed",
        });

        const lib = new FincraLib(baseOptions);

        await expect(lib.verifyPayoutByReference("ref-1")).rejects.toMatchObject({
            message: "invalid request",
            status: 400,
        });
    });

    it("should rethrow non-axios errors", async () => {
        mockAxiosInstance.mockRejectedValue(new Error("network down"));
        mockIsAxiosError.mockReturnValue(false);

        const lib = new FincraLib(baseOptions);

        await expect(lib.verifyPayoutByCustomerReference("cust-ref")).rejects.toThrow("network down");
    });

    it("should map axios error fallback message when response message is absent", async () => {
        mockIsAxiosError.mockReturnValue(true);
        mockAxiosInstance.mockRejectedValue({
            isAxios: true,
            message: "request failed hard",
            response: {
                status: 502,
                data: {},
            },
        });

        const lib = new FincraLib(baseOptions);

        await expect(lib.verifyPayoutByReference("ref-500")).rejects.toMatchObject({
            message: "request failed hard",
            status: 502,
        });
    });

    it("should fetch wallets with business ID", async () => {
        mockAxiosInstance.mockResolvedValue({
            data: {
                status: true,
                data: [{ currency: "NGN", availableBalance: 500000 }],
            },
        });

        const lib = new FincraLib(baseOptions);
        const result = await lib.getWallets();

        expect(result.status).toBe(true);
        expect(result.data).toHaveLength(1);
        expect(mockAxiosInstance).toHaveBeenCalledWith(
            expect.objectContaining({
                method: "GET",
                url: "/wallets",
                params: { businessID: "biz-1" },
            }),
        );
    });

    it("should throw when businessId is missing for getWallets", async () => {
        const lib = new FincraLib({ ...baseOptions, businessId: "" });

        await expect(lib.getWallets()).rejects.toThrow("Business ID is required");
    });
});
