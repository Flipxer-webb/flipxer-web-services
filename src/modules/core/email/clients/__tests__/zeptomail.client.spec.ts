import { ZeptoMailClient } from "../zeptomail.client";

const makeResponse = ({
    body = "",
    contentType = "application/json",
    ok = true,
    status = 200,
    statusText = "OK",
}: {
    body?: string;
    contentType?: string;
    ok?: boolean;
    status?: number;
    statusText?: string;
}) => ({
    headers: {
        get: jest.fn().mockReturnValue(contentType),
    },
    ok,
    status,
    statusText,
    text: jest.fn().mockResolvedValue(body),
});

describe("ZeptoMailClient", () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        globalThis.fetch = jest.fn();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        jest.restoreAllMocks();
    });

    it("normalizes a URL with path segments to the API origin", async () => {
        (globalThis.fetch as jest.Mock).mockResolvedValue(
            makeResponse({ body: '{"request_id":"req-1"}' }),
        );

        const client = new ZeptoMailClient({
            url: "https://api.zeptomail.com/v1.1/email",
            token: "secret-token",
        });

        await expect(
            client.sendMail({
                from: { address: "noreply@test.com" },
                to: [{ email_address: { address: "user@test.com" } }],
                subject: "Subject",
                textbody: "Text",
                htmlbody: "<p>HTML</p>",
            }),
        ).resolves.toEqual({ request_id: "req-1" });

        expect(globalThis.fetch).toHaveBeenCalledWith(
            "https://api.zeptomail.com/v1.1/email",
            expect.objectContaining({
                method: "POST",
                headers: expect.objectContaining({
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    Authorization: "Zoho-enczapikey secret-token",
                }),
            }),
        );
    });

    it("normalizes a bare host by assuming https", async () => {
        (globalThis.fetch as jest.Mock).mockResolvedValue(
            makeResponse({ body: '{"request_id":"req-bare"}' }),
        );

        const client = new ZeptoMailClient({
            url: "api.zeptomail.com",
            token: "secret-token",
        });

        await expect(
            client.sendMail({
                from: { address: "noreply@test.com" },
                to: [{ email_address: { address: "user@test.com" } }],
                subject: "Subject",
                textbody: "Text",
                htmlbody: "<p>HTML</p>",
            }),
        ).resolves.toEqual({ request_id: "req-bare" });

        expect(globalThis.fetch).toHaveBeenCalledWith(
            "https://api.zeptomail.com/v1.1/email",
            expect.any(Object),
        );
    });

    it("treats empty successful responses as accepted", async () => {
        (globalThis.fetch as jest.Mock).mockResolvedValue(
            makeResponse({ body: "", contentType: "", status: 202, statusText: "Accepted" }),
        );

        const client = new ZeptoMailClient({
            url: "https://api.zeptomail.com",
            token: "secret-token",
        });

        await expect(
            client.sendMail({
                from: { address: "noreply@test.com" },
                to: [{ email_address: { address: "user@test.com" } }],
                subject: "Subject",
                textbody: "Text",
                htmlbody: "<p>HTML</p>",
            }),
        ).resolves.toEqual({ ok: true, status: 202 });
    });

    it("returns plain-text successful responses without JSON parsing", async () => {
        (globalThis.fetch as jest.Mock).mockResolvedValue(
            makeResponse({ body: "queued", contentType: "text/plain" }),
        );

        const client = new ZeptoMailClient({
            url: "https://api.zeptomail.com",
            token: "secret-token",
        });

        await expect(
            client.sendMail({
                from: { address: "noreply@test.com" },
                to: [{ email_address: { address: "user@test.com" } }],
                subject: "Subject",
                textbody: "Text",
                htmlbody: "<p>HTML</p>",
            }),
        ).resolves.toBe("queued");
    });

    it("posts template emails to the template endpoint", async () => {
        (globalThis.fetch as jest.Mock).mockResolvedValue(
            makeResponse({ body: '{"request_id":"req-2"}' }),
        );

        const client = new ZeptoMailClient({
            url: "https://api.zeptomail.com",
            token: "secret-token",
        });

        await expect(
            client.sendMailWithTemplate({
                from: { address: "noreply@test.com" },
                to: [{ email_address: { address: "user@test.com" } }],
                template_alias: "verify-account",
            }),
        ).resolves.toEqual({ request_id: "req-2" });

        expect(globalThis.fetch).toHaveBeenCalledWith(
            "https://api.zeptomail.com/v1.1/email/template",
            expect.any(Object),
        );
    });

    it("posts template batches to the batch endpoint", async () => {
        (globalThis.fetch as jest.Mock).mockResolvedValue(
            makeResponse({ body: '{"request_id":"req-3"}' }),
        );

        const client = new ZeptoMailClient({
            url: "https://api.zeptomail.com",
            token: "secret-token",
        });

        await expect(
            client.mailBatchWithTemplate({
                from: { address: "noreply@test.com" },
                to: [{ email_address: { address: "user@test.com" } }],
                template_alias: "verify-account",
            }),
        ).resolves.toEqual({ request_id: "req-3" });

        expect(globalThis.fetch).toHaveBeenCalledWith(
            "https://api.zeptomail.com/v1.1/email/template/batch",
            expect.any(Object),
        );
    });

    it("logs and throws parsed API errors", async () => {
        (globalThis.fetch as jest.Mock).mockResolvedValue(
            makeResponse({
                body: '{"message":"bad request"}',
                ok: false,
                status: 400,
                statusText: "Bad Request",
            }),
        );

        const client = new ZeptoMailClient({
            url: "https://api.zeptomail.com",
            token: "secret-token",
        });
        const errorSpy = jest.spyOn((client as any).logger, "error").mockImplementation(() => undefined);

        await expect(
            client.sendMail({
                from: { address: "noreply@test.com" },
                to: [{ email_address: { address: "user@test.com" } }],
                subject: "Subject",
                textbody: "Text",
                htmlbody: "<p>HTML</p>",
            }),
        ).rejects.toThrow("bad request");

        expect(errorSpy).toHaveBeenCalledWith(
            "ZeptoMail API error [400]: bad request",
        );
    });

    it("uses plain-text error bodies when JSON parsing is not applicable", async () => {
        (globalThis.fetch as jest.Mock).mockResolvedValue(
            makeResponse({
                body: "provider timeout",
                contentType: "text/plain",
                ok: false,
                status: 504,
                statusText: "Gateway Timeout",
            }),
        );

        const client = new ZeptoMailClient({
            url: "https://api.zeptomail.com",
            token: "secret-token",
        });

        await expect(
            client.sendMail({
                from: { address: "noreply@test.com" },
                to: [{ email_address: { address: "user@test.com" } }],
                subject: "Subject",
                textbody: "Text",
                htmlbody: "<p>HTML</p>",
            }),
        ).rejects.toThrow("provider timeout");
    });

    it("falls back to statusText when an error response body is empty", async () => {
        (globalThis.fetch as jest.Mock).mockResolvedValue(
            makeResponse({
                body: "",
                contentType: "",
                ok: false,
                status: 401,
                statusText: "Unauthorized",
            }),
        );

        const client = new ZeptoMailClient({
            url: "https://api.zeptomail.com",
            token: "secret-token",
        });

        await expect(
            client.sendMail({
                from: { address: "noreply@test.com" },
                to: [{ email_address: { address: "user@test.com" } }],
                subject: "Subject",
                textbody: "Text",
                htmlbody: "<p>HTML</p>",
            }),
        ).rejects.toThrow("Unauthorized");
    });

    it("falls back to a generic status message when the error response has no body or status text", async () => {
        (globalThis.fetch as jest.Mock).mockResolvedValue(
            makeResponse({
                body: "",
                contentType: "",
                ok: false,
                status: 500,
                statusText: "",
            }),
        );

        const client = new ZeptoMailClient({
            url: "https://api.zeptomail.com",
            token: "secret-token",
        });

        await expect(
            client.sendMail({
                from: { address: "noreply@test.com" },
                to: [{ email_address: { address: "user@test.com" } }],
                subject: "Subject",
                textbody: "Text",
                htmlbody: "<p>HTML</p>",
            }),
        ).rejects.toThrow("ZeptoMail request failed with status 500");
    });

    it("returns malformed JSON payloads as raw text", async () => {
        (globalThis.fetch as jest.Mock).mockResolvedValue(
            makeResponse({ body: "{not-json}", contentType: "application/json" }),
        );

        const client = new ZeptoMailClient({
            url: "https://api.zeptomail.com",
            token: "secret-token",
        });

        await expect(
            client.sendMail({
                from: { address: "noreply@test.com" },
                to: [{ email_address: { address: "user@test.com" } }],
                subject: "Subject",
                textbody: "Text",
                htmlbody: "<p>HTML</p>",
            }),
        ).resolves.toBe("{not-json}");
    });

    it("throws a clear config error when ZeptoMail URL is empty", () => {
        expect(
            () =>
                new ZeptoMailClient({
                    url: "   ",
                    token: "secret-token",
                }),
        ).toThrow("ZEPTOMAIL_URL must not be empty");
    });

    it("throws a clear config error for invalid ZeptoMail URLs", () => {
        expect(
            () =>
                new ZeptoMailClient({
                    url: "http://",
                    token: "secret-token",
                }),
        ).toThrow("Invalid ZEPTOMAIL_URL: http://");
    });
});