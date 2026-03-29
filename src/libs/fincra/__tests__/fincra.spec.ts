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
});
