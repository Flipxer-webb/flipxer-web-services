const postMock = jest.fn();
const getMock = jest.fn();
const createMock = jest.fn(() => ({
    post: postMock,
    get: getMock,
}));

jest.mock("axios", () => ({
    __esModule: true,
    default: {
        create: createMock,
    },
    create: createMock,
}));

import { TermiiLib } from "../index";
import {
    TermiiAuthorizationError,
    TermiiGenericError,
    TermiiInsufficientBalanceError,
    TermiiValidationError,
} from "../errors";

describe("TermiiLib", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("creates axios instance with default base URL", () => {
        const lib = new TermiiLib({ apiKey: "k1" });
        expect(lib).toBeDefined();
        expect(createMock).toHaveBeenCalledWith(
            expect.objectContaining({
                baseURL: "https://v3.api.termii.com",
            })
        );
    });

    it("sends sms and applies default type/channel", async () => {
        postMock.mockResolvedValueOnce({
            data: {
                code: "ok",
                message_id: "mid-1",
            },
        });

        const lib = new TermiiLib({ apiKey: "k2", baseUrl: "https://mock.termii" });
        const result = await lib.sendSms({
            to: "2348012345678",
            from: "FLIPXER",
            sms: "hello",
        });

        expect(result.code).toBe("ok");
        expect(postMock).toHaveBeenCalledWith("/api/sms/send", {
            api_key: "k2",
            to: "2348012345678",
            from: "FLIPXER",
            sms: "hello",
            type: "plain",
            channel: "generic",
        });
    });

    it("maps 401 to TermiiAuthorizationError", async () => {
        postMock.mockRejectedValueOnce({
            response: { status: 401, data: { message: "Unauthorized" } },
            message: "Request failed",
        });

        const lib = new TermiiLib({ apiKey: "k3" });
        await expect(
            lib.sendSms({ to: "1", from: "f", sms: "m", type: "plain", channel: "generic" })
        ).rejects.toBeInstanceOf(TermiiAuthorizationError);
    });

    it("maps 400 to TermiiValidationError", async () => {
        postMock.mockRejectedValueOnce({
            response: { status: 400, data: { message: "Bad request" } },
            message: "Request failed",
        });

        const lib = new TermiiLib({ apiKey: "k4" });
        await expect(
            lib.sendSms({ to: "1", from: "f", sms: "m", type: "plain", channel: "generic" })
        ).rejects.toBeInstanceOf(TermiiValidationError);
    });

    it("maps 402 to TermiiInsufficientBalanceError", async () => {
        postMock.mockRejectedValueOnce({
            response: { status: 402, data: { message: "No balance" } },
            message: "Request failed",
        });

        const lib = new TermiiLib({ apiKey: "k5" });
        await expect(
            lib.sendSms({ to: "1", from: "f", sms: "m", type: "plain", channel: "generic" })
        ).rejects.toBeInstanceOf(TermiiInsufficientBalanceError);
    });

    it("maps unknown status to TermiiGenericError and preserves status", async () => {
        postMock.mockRejectedValueOnce({
            response: { status: 500, data: { message: "Server error" } },
            message: "Request failed",
        });

        const lib = new TermiiLib({ apiKey: "k6" });
        await expect(
            lib.sendSms({ to: "1", from: "f", sms: "m", type: "plain", channel: "generic" })
        ).rejects.toMatchObject({
            name: TermiiGenericError.name,
            status: 500,
        });
    });

    it("gets balance", async () => {
        getMock.mockResolvedValueOnce({
            data: {
                user: "demo",
                balance: 12,
                currency: "NGN",
            },
        });

        const lib = new TermiiLib({ apiKey: "bal-key" });
        const balance = await lib.getBalance();

        expect(balance.user).toBe("demo");
        expect(getMock).toHaveBeenCalledWith("/api/get-balance?api_key=bal-key");
    });

    it("maps getBalance errors too", async () => {
        getMock.mockRejectedValueOnce({
            response: { status: 401, data: { message: "Unauthorized" } },
            message: "Request failed",
        });

        const lib = new TermiiLib({ apiKey: "x" });
        await expect(lib.getBalance()).rejects.toBeInstanceOf(TermiiAuthorizationError);
    });

    it("rethrows original sendSms error when handler does not throw", async () => {
        const originalError = new Error("raw-send-error");
        postMock.mockRejectedValueOnce(originalError);

        const lib = new TermiiLib({ apiKey: "k7" });
        jest.spyOn(lib as any, "handleTermiiError").mockImplementation(() => undefined);

        await expect(
            lib.sendSms({ to: "1", from: "f", sms: "m", type: "plain", channel: "generic" })
        ).rejects.toBe(originalError);
    });

    it("rethrows original getBalance error when handler does not throw", async () => {
        const originalError = new Error("raw-balance-error");
        getMock.mockRejectedValueOnce(originalError);

        const lib = new TermiiLib({ apiKey: "k8" });
        jest.spyOn(lib as any, "handleTermiiError").mockImplementation(() => undefined);

        await expect(lib.getBalance()).rejects.toBe(originalError);
    });
});