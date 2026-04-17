import { ZeptoMailClient } from "../zeptomail.client";

describe("ZeptoMailClient", () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
        global.fetch = jest.fn();
    });

    afterEach(() => {
        global.fetch = originalFetch;
        jest.restoreAllMocks();
    });

    it("normalizes a URL with path segments to the API origin", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue({ request_id: "req-1" }),
        });

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

        expect(global.fetch).toHaveBeenCalledWith(
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

    it("posts template emails to the template endpoint", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue({ request_id: "req-2" }),
        });

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

        expect(global.fetch).toHaveBeenCalledWith(
            "https://api.zeptomail.com/v1.1/email/template",
            expect.any(Object),
        );
    });

    it("posts template batches to the batch endpoint", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue({ request_id: "req-3" }),
        });

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

        expect(global.fetch).toHaveBeenCalledWith(
            "https://api.zeptomail.com/v1.1/email/template/batch",
            expect.any(Object),
        );
    });

    it("logs and throws parsed API errors", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: false,
            status: 400,
            json: jest.fn().mockResolvedValue({ message: "bad request" }),
        });

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
        ).rejects.toEqual({ message: "bad request" });

        expect(errorSpy).toHaveBeenCalledWith(
            'ZeptoMail API error [400]: {"message":"bad request"}',
        );
    });
});