const axiosMock = jest.fn();
const createMock = jest.fn(() => axiosMock);

jest.mock("axios", () => ({
    __esModule: true,
    default: {
        create: createMock,
    },
    create: createMock,
}));

import { AmlBotLib } from "../index";
import {
    AmlBotAuthorizationError,
    AmlBotValidationError,
    AmlBotNetworkError,
    AmlBotRateLimitError,
    AmlBotGenericError,
} from "../errors";

const OPTIONS = {
    baseURL: "https://test.amlbot.com",
    accessKey: "testKey",
    accessId: "testId",
};

describe("AmlBotLib", () => {
    let lib: AmlBotLib;

    beforeEach(() => {
        jest.clearAllMocks();
        lib = new AmlBotLib(OPTIONS);
    });

    it("creates axios instance with correct config", () => {
        expect(createMock).toHaveBeenCalledWith(
            expect.objectContaining({
                baseURL: OPTIONS.baseURL,
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
            })
        );
    });

    describe("getSupportedCoins", () => {
        it("returns coin data on success", async () => {
            axiosMock.mockResolvedValueOnce({ data: ["BTC", "ETH"] });
            const result = await lib.getSupportedCoins();
            expect(result).toEqual(["BTC", "ETH"]);
            expect(axiosMock).toHaveBeenCalledWith({ url: "/coins/", method: "GET" });
        });

        it("throws AmlBotNetworkError on network failure", async () => {
            axiosMock.mockRejectedValueOnce({ message: "timeout", code: "ECONNABORTED" });
            await expect(lib.getSupportedCoins()).rejects.toBeInstanceOf(AmlBotNetworkError);
        });
    });

    describe("checkAddress", () => {
        it("returns address data on success", async () => {
            const mockResp = {
                data: {
                    result: true,
                    balance: 10,
                    data: { riskscore: 0.1, address: "addr1", asset: "BTC" },
                },
            };
            axiosMock.mockResolvedValueOnce(mockResp);

            const result = await lib.checkAddress({ hash: "addr1", asset: "BTC" });
            expect(result.result).toBe(true);
            expect(result.data.riskscore).toBe(0.1);
        });

        it("throws AmlBotAuthorizationError on invalid token response", async () => {
            axiosMock.mockResolvedValueOnce({
                data: { result: false, description: "Invalid token" },
            });
            await expect(
                lib.checkAddress({ hash: "addr1", asset: "BTC" })
            ).rejects.toBeInstanceOf(AmlBotAuthorizationError);
        });

        it("throws AmlBotValidationError on other failure response", async () => {
            axiosMock.mockResolvedValueOnce({
                data: { result: false, description: "Unknown asset" },
            });
            await expect(
                lib.checkAddress({ hash: "addr1", asset: "FAKE" })
            ).rejects.toBeInstanceOf(AmlBotValidationError);
        });
    });

    describe("checkTransaction", () => {
        it("returns transaction data on success", async () => {
            const mockResp = {
                data: {
                    result: true,
                    balance: 5,
                    data: {
                        riskscore: 0.5,
                        tx: "txhash",
                        address: "addr1",
                        asset: "ETH",
                        direction: "deposit",
                    },
                },
            };
            axiosMock.mockResolvedValueOnce(mockResp);

            const result = await lib.checkTransaction({
                hash: "txhash",
                address: "addr1",
                direction: "deposit",
                asset: "ETH",
            });
            expect(result.data.riskscore).toBe(0.5);
        });
    });

    describe("recheck", () => {
        it("returns recheck data on success", async () => {
            const mockResp = {
                data: {
                    result: true,
                    data: { riskscore: 0.25, status: "success", address: "addr1" },
                },
            };
            axiosMock.mockResolvedValueOnce(mockResp);

            const result = await lib.recheck({ uid: "uid123" });
            expect(result.data.riskscore).toBe(0.25);
        });
    });

    describe("investigate", () => {
        it("returns investigation data on success", async () => {
            const mockResp = {
                data: {
                    result: true,
                    data: {
                        riskscore: 0.3,
                        indirects: { connections: [], debug: null },
                        address: "addr1",
                        asset: "ETH",
                    },
                },
            };
            axiosMock.mockResolvedValueOnce(mockResp);

            const result = await lib.investigate({
                hash: "addr1",
                asset: "ETH",
                expanded: 1,
            });
            expect(result.data.riskscore).toBe(0.3);
        });

        it("passes tokenData when provided", async () => {
            axiosMock.mockResolvedValueOnce({
                data: {
                    result: true,
                    data: { riskscore: 0, indirects: { connections: [] } },
                },
            });

            await lib.investigate({
                hash: "addr1",
                asset: "ETH",
                expanded: 1,
                tokenData: "0xdac17f958d2ee523a2206206994597c13d831ec7",
            });

            expect(axiosMock).toHaveBeenCalledWith(
                expect.objectContaining({
                    url: "/",
                    method: "POST",
                })
            );
            // Verify tokenData is in the POST body
            const callData = axiosMock.mock.calls[0][0].data;
            expect(callData).toContain("tokenData=0xdac17f958d2ee523a2206206994597c13d831ec7");
        });
    });

    describe("getHistory", () => {
        it("returns history data on success", async () => {
            const mockResp = {
                data: {
                    result: true,
                    pageLimit: 15,
                    totalCount: "2",
                    data: [{ riskscore: 0.1 }, { riskscore: 0.5 }],
                    balance: 3,
                },
            };
            axiosMock.mockResolvedValueOnce(mockResp);

            const result = await lib.getHistory({ page: 0 });
            expect(result.totalCount).toBe("2");
        });

        it("uses defaults when no options provided", async () => {
            axiosMock.mockResolvedValueOnce({
                data: { result: true, pageLimit: 15, totalCount: "0", data: [], balance: 0 },
            });

            await lib.getHistory();
            expect(axiosMock).toHaveBeenCalled();
        });
    });

    describe("error handling", () => {
        it("throws AmlBotAuthorizationError on 401", async () => {
            axiosMock.mockRejectedValueOnce({
                response: { status: 401, data: { description: "Unauthorized" } },
                message: "Request failed",
            });
            await expect(lib.getSupportedCoins()).rejects.toBeInstanceOf(
                AmlBotAuthorizationError
            );
        });

        it("throws AmlBotValidationError on 400", async () => {
            axiosMock.mockRejectedValueOnce({
                response: { status: 400, data: { description: "Bad request" } },
                message: "Request failed",
            });
            await expect(lib.getSupportedCoins()).rejects.toBeInstanceOf(
                AmlBotValidationError
            );
        });

        it("throws AmlBotRateLimitError on 429", async () => {
            axiosMock.mockRejectedValueOnce({
                response: { status: 429, data: { description: "Rate limit" } },
                message: "Request failed",
            });
            await expect(lib.getSupportedCoins()).rejects.toBeInstanceOf(
                AmlBotRateLimitError
            );
        });

        it("throws AmlBotGenericError on unknown status", async () => {
            axiosMock.mockRejectedValueOnce({
                response: { status: 500, data: {}, statusText: "Server Error" },
                message: "Request failed",
            });
            await expect(lib.getSupportedCoins()).rejects.toBeInstanceOf(
                AmlBotGenericError
            );
        });

        it("throws AmlBotNetworkError on ENOTFOUND", async () => {
            axiosMock.mockRejectedValueOnce({
                message: "not found",
                code: "ENOTFOUND",
            });
            await expect(lib.getSupportedCoins()).rejects.toBeInstanceOf(
                AmlBotNetworkError
            );
        });

        it("throws AmlBotNetworkError with generic message when no code", async () => {
            axiosMock.mockRejectedValueOnce({
                message: "something broke",
            });
            await expect(lib.getSupportedCoins()).rejects.toBeInstanceOf(
                AmlBotNetworkError
            );
        });
    });
});
