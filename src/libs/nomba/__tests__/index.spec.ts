const postMock = jest.fn();
const getMock = jest.fn();

const requestUseMock = jest.fn();
const responseUseMock = jest.fn();

const mockAxiosInstance = {
    post: postMock,
    get: getMock,
    interceptors: {
        request: {
            use: requestUseMock,
        },
        response: {
            use: responseUseMock,
        },
    },
};

const createMock = jest.fn(() => mockAxiosInstance);
const isAxiosErrorMock = jest.fn((error: unknown) => Boolean((error as any)?.isAxiosError));

jest.mock("axios", () => {
    const axiosDefault: any = jest.fn();
    axiosDefault.create = createMock;
    axiosDefault.isAxiosError = isAxiosErrorMock;

    return {
        __esModule: true,
        default: axiosDefault,
        create: createMock,
        isAxiosError: isAxiosErrorMock,
    };
});

import { Logger } from "@nestjs/common";
import { NombaLib } from "../index";

describe("NombaLib", () => {
    const baseOptions = {
        baseUrl: "https://api.nomba.test",
        clientId: "client-id",
        clientSecret: "client-secret",
        accountId: "account-1",
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("creates axios instance with required headers", () => {
        const lib = new NombaLib(baseOptions);

        expect(lib).toBeDefined();
        expect(createMock).toHaveBeenCalledWith(
            expect.objectContaining({
                baseURL: baseOptions.baseUrl,
                headers: {
                    "Content-Type": "application/json",
                    accountId: baseOptions.accountId,
                },
            })
        );
        expect(requestUseMock).toHaveBeenCalledTimes(2);
        expect(responseUseMock).toHaveBeenCalledTimes(1);
    });

    it("sanitizes secrets from payload", () => {
        const lib = new NombaLib(baseOptions);
        const privateLib = lib as any;

        const sanitized = privateLib.sanitizeNombaPayload({
            client_secret: "super-secret",
            data: {
                access_token: "access",
                refresh_token: "refresh",
            },
        });

        expect(sanitized).toEqual({
            client_secret: "[REDACTED]",
            data: {
                access_token: "[REDACTED]",
                refresh_token: "[REDACTED]",
            },
        });
    });

    it("returns fallback marker for unserializable payload", () => {
        const lib = new NombaLib(baseOptions);
        const privateLib = lib as any;

        const sanitized = privateLib.sanitizeNombaPayload({ fn: () => "x" });

        expect(sanitized).toBe("[UNSERIALIZABLE_PAYLOAD]");
    });

    it("uses fallback expiry and warns when expiresAt is invalid", () => {
        const lib = new NombaLib(baseOptions);
        const privateLib = lib as any;
        const warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

        const nowSpy = jest.spyOn(Date, "now").mockReturnValue(1_000_000);
        const expiry = privateLib.resolveTokenExpiry("invalid-date");

        expect(expiry).toBe(1_000_000 + 55 * 60 * 1000);
        expect(warnSpy).toHaveBeenCalled();

        nowSpy.mockRestore();
        warnSpy.mockRestore();
    });

    it("issues an access token and updates token cache", async () => {
        postMock.mockResolvedValueOnce({
            data: {
                code: "00",
                description: "ok",
                data: {
                    access_token: "new-access",
                    refresh_token: "new-refresh",
                    expiresAt: "2030-01-01T00:00:00.000Z",
                },
            },
        });

        const lib = new NombaLib(baseOptions);
        const privateLib = lib as any;

        await privateLib.obtainAccessToken();

        expect(postMock).toHaveBeenCalledWith("/v1/auth/token/issue", {
            grant_type: "client_credentials",
            client_id: baseOptions.clientId,
            client_secret: baseOptions.clientSecret,
        });
        expect(privateLib.tokenCache).toEqual(
            expect.objectContaining({
                accessToken: "new-access",
                refreshToken: "new-refresh",
            })
        );
    });

    it("refreshes token with current access token in authorization header", async () => {
        postMock.mockResolvedValueOnce({
            data: {
                code: "00",
                description: "ok",
                data: {
                    access_token: "refreshed-access",
                    refresh_token: "refreshed-refresh",
                    expiresAt: "2031-01-01T00:00:00.000Z",
                },
            },
        });

        const lib = new NombaLib(baseOptions);
        const privateLib = lib as any;
        privateLib.tokenCache = {
            accessToken: "current-access",
            refreshToken: "current-refresh",
            expiresAt: Date.now() - 10_000,
        };

        await privateLib.refreshAccessToken("current-refresh");

        expect(postMock).toHaveBeenCalledWith(
            "/v1/auth/token/refresh",
            {
                grant_type: "refresh_token",
                refresh_token: "current-refresh",
            },
            {
                headers: {
                    Authorization: "Bearer current-access",
                },
            }
        );
        expect(privateLib.tokenCache.accessToken).toBe("refreshed-access");
    });

    it("returns cached token when still valid", async () => {
        const lib = new NombaLib(baseOptions);
        const privateLib = lib as any;

        privateLib.tokenCache = {
            accessToken: "cached-token",
            refreshToken: "cached-refresh",
            expiresAt: Date.now() + 5 * 60 * 1000,
        };

        const token = await privateLib.getValidToken();

        expect(token).toBe("cached-token");
        expect(postMock).not.toHaveBeenCalled();
    });

    it("falls back to issuing a new token when refresh fails", async () => {
        const lib = new NombaLib(baseOptions);
        const privateLib = lib as any;

        privateLib.tokenCache = {
            accessToken: "old-token",
            refreshToken: "old-refresh",
            expiresAt: Date.now() - 10_000,
        };

        jest.spyOn(privateLib, "refreshAccessToken").mockRejectedValueOnce(new Error("refresh-failed"));
        jest.spyOn(privateLib, "obtainAccessToken").mockImplementationOnce(async () => {
            privateLib.tokenCache = {
                accessToken: "fresh-token",
                refreshToken: "fresh-refresh",
                expiresAt: Date.now() + 10 * 60 * 1000,
            };
            return {
                code: "00",
                description: "ok",
                data: {
                    access_token: "fresh-token",
                    refresh_token: "fresh-refresh",
                    expiresAt: "2032-01-01T00:00:00.000Z",
                },
            };
        });

        const token = await privateLib.getValidToken();

        expect(token).toBe("fresh-token");
        expect(privateLib.refreshAccessToken).toHaveBeenCalledWith("old-refresh");
        expect(privateLib.obtainAccessToken).toHaveBeenCalled();
    });

    it("auth request interceptor skips token retrieval on token endpoints", async () => {
        const lib = new NombaLib(baseOptions);
        const privateLib = lib as any;
        const getValidTokenSpy = jest.spyOn(privateLib, "getValidToken");

        const authInterceptor = requestUseMock.mock.calls[0][0];
        const config = await authInterceptor({
            url: "/v1/auth/token/issue",
            headers: {},
        });

        expect(config.headers.Authorization).toBeUndefined();
        expect(getValidTokenSpy).not.toHaveBeenCalled();
    });

    it("auth request interceptor attaches bearer token for protected endpoints", async () => {
        const lib = new NombaLib(baseOptions);
        const privateLib = lib as any;

        jest.spyOn(privateLib, "getValidToken").mockResolvedValueOnce("token-123");

        const authInterceptor = requestUseMock.mock.calls[0][0];
        const config = await authInterceptor({
            url: "/v1/transfers/banks",
            headers: {},
        });

        expect(config.headers.Authorization).toBe("Bearer token-123");
    });

    it("maps axios errors to Error with status and code", () => {
        isAxiosErrorMock.mockReturnValueOnce(true);

        const lib = new NombaLib(baseOptions);
        const privateLib = lib as any;

        expect(() => {
            privateLib.handleError({
                isAxiosError: true,
                response: {
                    status: 400,
                    data: {
                        code: "E100",
                        description: "invalid request",
                    },
                },
                message: "request failed",
            });
        }).toThrow("invalid request");

        try {
            privateLib.handleError({
                isAxiosError: true,
                response: {
                    status: 422,
                    data: {
                        code: "E422",
                        message: "unprocessable",
                    },
                },
                message: "request failed",
            });
        } catch (error) {
            expect(error).toMatchObject({
                message: "unprocessable",
                status: 422,
                code: "E422",
            });
        }
    });

    it("rethrows non-axios errors unchanged", () => {
        isAxiosErrorMock.mockReturnValueOnce(false);

        const lib = new NombaLib(baseOptions);
        const privateLib = lib as any;
        const originalError = new Error("boom");

        expect(() => privateLib.handleError(originalError)).toThrow(originalError);
    });

    it("applies default currency/tokenizeCard and forwards checkout payload", async () => {
        postMock.mockResolvedValueOnce({
            data: {
                code: "00",
                description: "ok",
                data: {
                    orderReference: "ord-1",
                    checkoutLink: "https://checkout",
                    amount: 1200,
                    currency: "NGN",
                    status: "PENDING",
                },
            },
        });

        const lib = new NombaLib(baseOptions);
        await lib.createCheckoutOrder({
            order: {
                orderReference: "ord-1",
                customerId: "cust-1",
                amount: 1200,
            },
        });

        expect(postMock).toHaveBeenCalledWith(
            "/v1/checkout/order",
            {
                order: {
                    orderReference: "ord-1",
                    customerId: "cust-1",
                    amount: 1200,
                    currency: "NGN",
                },
                tokenizeCard: false,
            }
        );
    });

    it("forwards transfer and account endpoints with expected payloads", async () => {
        getMock.mockResolvedValue({ data: { code: "00", description: "ok", data: {} } });
        postMock.mockResolvedValue({ data: { code: "00", description: "ok", data: {} } });

        const lib = new NombaLib(baseOptions);

        await lib.lookupBankAccount({ accountNumber: "0123456789", bankCode: "058" });
        await lib.createVirtualAccount({ accountRef: "va-1", accountName: "Test User" });
        await lib.getVirtualAccount("va-1");
        await lib.initiateBankTransfer({
            amount: 500,
            accountNumber: "0123456789",
            accountName: "Test User",
            bankCode: "058",
            merchantTxRef: "mref-1",
        });
        await lib.getTransferStatus("t-1");
        await lib.getTransferByMerchantRef("mref-1");
        await lib.getCheckoutStatus("ord-1");

        expect(postMock).toHaveBeenCalledWith("/v1/transfers/bank/lookup", {
            accountNumber: "0123456789",
            bankCode: "058",
        });
        expect(postMock).toHaveBeenCalledWith("/v1/accounts/virtual", {
            accountRef: "va-1",
            accountName: "Test User",
            currency: "NGN",
        });
        expect(getMock).toHaveBeenCalledWith("/v1/accounts/virtual/va-1");
        expect(postMock).toHaveBeenCalledWith("/v2/transfers/bank", {
            amount: 500,
            accountNumber: "0123456789",
            accountName: "Test User",
            bankCode: "058",
            merchantTxRef: "mref-1",
        });
        expect(getMock).toHaveBeenCalledWith("/v2/transfers/t-1");
        expect(getMock).toHaveBeenCalledWith("/v2/transfers/merchant-ref/mref-1");
        expect(getMock).toHaveBeenCalledWith("/v1/checkout/transaction", {
            params: {
                idType: "ORDER_REFERENCE",
                id: "ord-1",
            },
        });
    });

    it("warns when bank list is empty and returns data", async () => {
        const warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

        getMock.mockResolvedValueOnce({
            data: {
                code: "00",
                description: "ok",
                data: [],
            },
        });

        const lib = new NombaLib(baseOptions);
        const result = await lib.getBanks();

        expect(result.code).toBe("00");
        expect(getMock).toHaveBeenCalledWith("/v1/transfers/banks");
        expect(warnSpy).toHaveBeenCalled();

        warnSpy.mockRestore();
    });

    it("getAccountBalance returns balance data", async () => {
        getMock.mockResolvedValueOnce({
            data: {
                code: "00",
                data: { balance: 300000, currency: "NGN", availableBalance: 280000 },
            },
        });

        const lib = new NombaLib(baseOptions);
        const result = await lib.getAccountBalance();

        expect(result.code).toBe("00");
        expect(result.data.balance).toBe(300000);
        expect(getMock).toHaveBeenCalledWith(`/v1/accounts/${baseOptions.accountId}`);
    });

    it("getAccountBalance throws on network error", async () => {
        getMock.mockRejectedValueOnce(new Error("connection timeout"));

        const lib = new NombaLib(baseOptions);

        await expect(lib.getAccountBalance()).rejects.toThrow();
    });
});
