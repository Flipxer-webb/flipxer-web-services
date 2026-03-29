const postMock = jest.fn();
const createMock = jest.fn(() => ({ post: postMock }));
const isAxiosErrorMock = jest.fn((err: unknown) => Boolean((err as any)?.isAxiosError));

jest.mock("axios", () => ({
    __esModule: true,
    default: {
        create: createMock,
        isAxiosError: isAxiosErrorMock,
    },
    create: createMock,
    isAxiosError: isAxiosErrorMock,
}));

import { SendchampLib } from "../index";
import {
    SendchampAuthorizationError,
    SendchampGenericError,
    SendchampInsufficientBalanceError,
    SendchampValidationError,
} from "../errors";

describe("SendchampLib", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("throws when access key is missing", () => {
        expect(() => new SendchampLib({ accessKey: "" })).toThrow(
            SendchampAuthorizationError
        );
    });

    it("creates axios client with defaults", () => {
        const client = new SendchampLib({ accessKey: "key-1" });

        expect(client).toBeDefined();
        expect(createMock).toHaveBeenCalledWith(
            expect.objectContaining({
                baseURL: "https://api.sendchamp.com/api/v1",
                timeout: 30000,
                headers: expect.objectContaining({
                    Authorization: "Bearer key-1",
                }),
            })
        );
    });

    it("sendSms normalizes recipient and applies default route", async () => {
        postMock.mockResolvedValueOnce({
            data: {
                code: 200,
                message: "ok",
                status: "success",
                data: {
                    id: "id-1",
                    phone_number: "+2348012345678",
                    reference: "ref-1",
                    status: "queued",
                },
            },
        });

        const client = new SendchampLib({ accessKey: "key-2" });
        const response = await client.sendSms({
            to: "+2348012345678",
            message: "hello",
            sender_name: "Flipxer",
        });

        expect(postMock).toHaveBeenCalledWith("/sms/send", {
            to: ["+2348012345678"],
            message: "hello",
            sender_name: "Flipxer",
            route: "non_dnd",
        });
        expect(response.status).toBe("success");
    });

    it("sendSms preserves route and multi-recipient arrays", async () => {
        postMock.mockResolvedValueOnce({
            data: {
                code: 200,
                message: "ok",
                status: "success",
                data: {
                    id: "id-2",
                    phone_number: "+2348011111111",
                    reference: "ref-2",
                    status: "queued",
                },
            },
        });

        const client = new SendchampLib({
            accessKey: "key-3",
            baseUrl: "https://custom.sendchamp",
        });

        await client.sendSms({
            to: ["+2348011111111", "+2348022222222"],
            message: "bulk",
            sender_name: "Flipxer",
            route: "dnd",
        });

        expect(postMock).toHaveBeenCalledWith("/sms/send", {
            to: ["+2348011111111", "+2348022222222"],
            message: "bulk",
            sender_name: "Flipxer",
            route: "dnd",
        });
    });

    it("maps 401 to SendchampAuthorizationError", async () => {
        postMock.mockRejectedValueOnce({
            isAxiosError: true,
            response: {
                status: 401,
                data: { message: "Unauthorized" },
            },
            message: "request failed",
        });

        const client = new SendchampLib({ accessKey: "key-4" });
        await expect(
            client.sendSms({
                to: "+23480",
                message: "x",
                sender_name: "Flipxer",
            })
        ).rejects.toBeInstanceOf(SendchampAuthorizationError);
    });

    it("maps 402 to SendchampInsufficientBalanceError", async () => {
        postMock.mockRejectedValueOnce({
            isAxiosError: true,
            response: {
                status: 402,
                data: { message: "No balance" },
            },
            message: "request failed",
        });

        const client = new SendchampLib({ accessKey: "key-5" });
        await expect(
            client.sendSms({
                to: "+23480",
                message: "x",
                sender_name: "Flipxer",
            })
        ).rejects.toBeInstanceOf(SendchampInsufficientBalanceError);
    });

    it("maps 422 to SendchampValidationError", async () => {
        postMock.mockRejectedValueOnce({
            isAxiosError: true,
            response: {
                status: 422,
                data: { message: "Invalid payload" },
            },
            message: "request failed",
        });

        const client = new SendchampLib({ accessKey: "key-6" });
        await expect(
            client.sendSms({
                to: "+23480",
                message: "x",
                sender_name: "Flipxer",
            })
        ).rejects.toBeInstanceOf(SendchampValidationError);
    });

    it("maps unknown axios errors to SendchampGenericError", async () => {
        postMock.mockRejectedValueOnce({
            isAxiosError: true,
            response: {
                status: 500,
                data: { message: "Server exploded" },
            },
            message: "request failed",
        });

        const client = new SendchampLib({ accessKey: "key-7" });
        await expect(
            client.sendSms({
                to: "+23480",
                message: "x",
                sender_name: "Flipxer",
            })
        ).rejects.toBeInstanceOf(SendchampGenericError);
    });

    it("maps non-axios errors to SendchampGenericError", async () => {
        isAxiosErrorMock.mockReturnValueOnce(false);
        postMock.mockRejectedValueOnce(new Error("unexpected"));

        const client = new SendchampLib({ accessKey: "key-8" });
        await expect(
            client.sendSms({
                to: "+23480",
                message: "x",
                sender_name: "Flipxer",
            })
        ).rejects.toBeInstanceOf(SendchampGenericError);
    });
});
