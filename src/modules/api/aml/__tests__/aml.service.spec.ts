import { AmlService } from "../services";
import { AmlBotLib } from "@/libs/amlbot";
import {
    AmlBotAuthorizationError,
    AmlBotValidationError,
    AmlBotNetworkError,
    AmlBotInsufficientBalanceError,
    AmlBotRateLimitError,
} from "@/libs/amlbot/errors";
import { APIServiceHttpException } from "@/utils/errors";

const mockAmlBot = {
    checkAddress: jest.fn(),
    checkTransaction: jest.fn(),
    recheck: jest.fn(),
    investigate: jest.fn(),
    getHistory: jest.fn(),
    getSupportedCoins: jest.fn(),
} as unknown as AmlBotLib;

describe("AmlService", () => {
    let service: AmlService;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new AmlService(mockAmlBot);
    });

    describe("checkAddress", () => {
        it("returns completed response for instant chains", async () => {
            (mockAmlBot.checkAddress as jest.Mock).mockResolvedValueOnce({
                result: true,
                balance: 10,
                data: {
                    riskscore: 0.1,
                    signals: { mixer: 0 },
                    address: "addr1",
                    asset: "BTC",
                    counterparty: { name: "Binance" },
                    blackListsConnections: false,
                    hasBlackListFlag: false,
                    pdfReport: "https://report.url",
                    timestamp: "2026-01-01",
                },
            });

            const result = await service.checkAddress({ hash: "addr1", asset: "BTC" });
            expect(result.success).toBe(true);
            expect((result.data as any).riskscore).toBe(0.1);
        });

        it("returns pending response for async chains", async () => {
            (mockAmlBot.checkAddress as jest.Mock).mockResolvedValueOnce({
                result: true,
                data: {
                    uid: "uid123",
                    status: "pending",
                    address: "TRXaddr",
                    asset: "TRX",
                },
            });

            const result = await service.checkAddress({ hash: "TRXaddr", asset: "TRX" });
            expect((result.data as any).status).toBe("pending");
            expect((result.data as any).uid).toBe("uid123");
        });

        it("throws APIServiceHttpException on auth error", async () => {
            (mockAmlBot.checkAddress as jest.Mock).mockRejectedValueOnce(
                new AmlBotAuthorizationError("bad token")
            );

            await expect(
                service.checkAddress({ hash: "addr1", asset: "BTC" })
            ).rejects.toBeInstanceOf(APIServiceHttpException);
        });
    });

    describe("checkTransaction", () => {
        it("returns completed transaction response", async () => {
            (mockAmlBot.checkTransaction as jest.Mock).mockResolvedValueOnce({
                result: true,
                balance: 5,
                data: {
                    riskscore: 0.5,
                    signals: {},
                    tx: "txhash",
                    address: "addr1",
                    asset: "ETH",
                    amount: 1000,
                    direction: "deposit",
                    risky_volume: 0,
                    risky_volume_fiat: 0,
                    counterparty: {},
                    blackListsConnections: false,
                    hasBlackListFlag: false,
                    pdfReport: "url",
                    timestamp: "2026-01-01",
                },
            });

            const result = await service.checkTransaction({
                hash: "txhash",
                address: "addr1",
                direction: "deposit",
                asset: "ETH",
            });
            expect(result.success).toBe(true);
            expect(result.data.tx).toBe("txhash");
        });

        it("returns pending for async chains", async () => {
            (mockAmlBot.checkTransaction as jest.Mock).mockResolvedValueOnce({
                result: true,
                data: { uid: "uid456", status: "pending", tx: "txhash", asset: "TRX" },
            });

            const result = await service.checkTransaction({
                hash: "txhash",
                address: "addr1",
                direction: "deposit",
                asset: "TRX",
            });
            expect((result.data as any).status).toBe("pending");
        });
    });

    describe("recheck", () => {
        it("returns completed recheck", async () => {
            (mockAmlBot.recheck as jest.Mock).mockResolvedValueOnce({
                result: true,
                balance: 3,
                data: {
                    riskscore: 0.25,
                    status: "success",
                    signals: {},
                    address: "addr1",
                    asset: "TRX",
                    counterparty: {},
                    blackListsConnections: false,
                    hasBlackListFlag: false,
                    pdfReport: "url",
                    timestamp: "2026-01-01",
                },
            });

            const result = await service.recheck({ uid: "uid123" });
            expect((result.data as any).riskscore).toBe(0.25);
        });

        it("returns pending when still processing", async () => {
            (mockAmlBot.recheck as jest.Mock).mockResolvedValueOnce({
                result: true,
                data: { uid: "uid123", status: "pending" },
            });

            const result = await service.recheck({ uid: "uid123" });
            expect((result.data as any).status).toBe("pending");
        });
    });

    describe("investigate", () => {
        it("returns investigation data", async () => {
            (mockAmlBot.investigate as jest.Mock).mockResolvedValueOnce({
                result: true,
                balance: 2,
                data: {
                    riskscore: 0.3,
                    indirects: { connections: [{ entity: { name: "Binance" } }] },
                    address: "addr1",
                    asset: "ETH",
                    counterparty: {},
                    identifier: "id123",
                    timestamp: "2026-01-01",
                },
            });

            const result = await service.investigate({ hash: "addr1", asset: "ETH" });
            expect(result.data.connections).toHaveLength(1);
        });
    });

    describe("getHistory", () => {
        it("returns history data", async () => {
            (mockAmlBot.getHistory as jest.Mock).mockResolvedValueOnce({
                result: true,
                totalCount: "5",
                pageLimit: 15,
                balance: 10,
                data: [{ riskscore: 0.1 }],
            });

            const result = await service.getHistory({ page: 0 });
            expect(result.data.totalCount).toBe("5");
        });
    });

    describe("getSupportedCoins", () => {
        it("returns supported coins", async () => {
            (mockAmlBot.getSupportedCoins as jest.Mock).mockResolvedValueOnce(["BTC", "ETH"]);

            const result = await service.getSupportedCoins();
            expect(result.success).toBe(true);
        });
    });

    describe("error handling", () => {
        it("maps AmlBotValidationError to 400", async () => {
            (mockAmlBot.checkAddress as jest.Mock).mockRejectedValueOnce(
                new AmlBotValidationError("bad input")
            );

            try {
                await service.checkAddress({ hash: "x", asset: "BTC" });
                fail("should throw");
            } catch (error) {
                expect(error).toBeInstanceOf(APIServiceHttpException);
                expect(error.getStatus()).toBe(400);
            }
        });

        it("maps AmlBotInsufficientBalanceError to 503", async () => {
            (mockAmlBot.checkAddress as jest.Mock).mockRejectedValueOnce(
                new AmlBotInsufficientBalanceError("no balance")
            );

            try {
                await service.checkAddress({ hash: "x", asset: "BTC" });
                fail("should throw");
            } catch (error) {
                expect(error).toBeInstanceOf(APIServiceHttpException);
                expect(error.getStatus()).toBe(503);
            }
        });

        it("maps AmlBotNetworkError to 502", async () => {
            (mockAmlBot.checkAddress as jest.Mock).mockRejectedValueOnce(
                new AmlBotNetworkError("timeout")
            );

            try {
                await service.checkAddress({ hash: "x", asset: "BTC" });
                fail("should throw");
            } catch (error) {
                expect(error).toBeInstanceOf(APIServiceHttpException);
                expect(error.getStatus()).toBe(502);
            }
        });

        it("maps AmlBotRateLimitError to 429", async () => {
            (mockAmlBot.checkAddress as jest.Mock).mockRejectedValueOnce(
                new AmlBotRateLimitError("rate limited")
            );

            try {
                await service.checkAddress({ hash: "x", asset: "BTC" });
                fail("should throw");
            } catch (error) {
                expect(error).toBeInstanceOf(APIServiceHttpException);
                expect(error.getStatus()).toBe(429);
            }
        });

        it("maps unknown errors to 502", async () => {
            (mockAmlBot.checkAddress as jest.Mock).mockRejectedValueOnce(
                new Error("unknown")
            );

            try {
                await service.checkAddress({ hash: "x", asset: "BTC" });
                fail("should throw");
            } catch (error) {
                expect(error).toBeInstanceOf(APIServiceHttpException);
                expect(error.getStatus()).toBe(502);
            }
        });
    });
});
