jest.mock("@/config", () => ({
    mailConfig: {
        host: "mailhog",
        port: 1025,
        secure: false,
        user: undefined,
        pass: undefined,
    },
    emailTemplateConfig: {
        registration_success: "tpl-registration",
        verify_account: "zepto-verify-account-key",
        forgot_password: "tpl-forgot",
        recovery_pin: "tpl-recovery-pin",
        transaction_notification: "tpl-transaction-notification",
        transaction_failed: "tpl-transaction-failed",
        document_approved: "zepto-document-approved-key",
        document_rejected: "tpl-document-rejected",
        document_pending_review: "tpl-document-pending-review",
        document_escalated: "tpl-document-escalated",
        admin_invite: "tpl-admin-invite",
        transaction_otp: "tpl-transaction-otp",
    },
}));

jest.mock("node:fs", () => ({
    __esModule: true,
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
}));

import * as fs from "node:fs";
import nodemailer from "nodemailer";

import { SmtpMailClient } from "../smtp-mail.client";

const existsSyncMock = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
const readFileSyncMock =
    fs.readFileSync as jest.MockedFunction<typeof fs.readFileSync>;

describe("SmtpMailClient", () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        process.env = { ...originalEnv };
        jest.clearAllMocks();
        existsSyncMock.mockReset().mockReturnValue(false);
        readFileSyncMock.mockReset();
        jest.spyOn(console, "log").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        process.env = { ...originalEnv };
    });

    it("maps sendMail payloads to nodemailer", async () => {
        const transporter = {
            sendMail: jest.fn().mockResolvedValue({ accepted: ["user@test.com"] }),
        } as any;
        const client = new SmtpMailClient(transporter);

        await expect(
            client.sendMail({
                from: { address: "noreply@test.com", name: "Flipxer" },
                to: [{ email_address: { address: "user@test.com" } }],
                subject: "Subject",
                textbody: "Text body",
                htmlbody: "<p>HTML body</p>",
            } as never)
        ).resolves.toEqual({ accepted: ["user@test.com"] });

        expect(transporter.sendMail).toHaveBeenCalledWith(
            expect.objectContaining({
                from: "Flipxer <noreply@test.com>",
                to: ["user@test.com"],
                subject: "Subject",
                text: "Text body",
                html: "<p>HTML body</p>",
            })
        );
    });

    it("builds the default transporter from SMTP environment variables", () => {
        const transporter = {
            sendMail: jest.fn(),
        } as any;

        process.env.SMTP_HOST = "smtp.flipxer.local";
        process.env.SMTP_PORT = "465";
        process.env.SMTP_SECURE = "true";
        process.env.SMTP_USER = "smtp-user";
        process.env.SMTP_PASS = "smtp-pass";

        const createTransportSpy = jest
            .spyOn(nodemailer, "createTransport")
            .mockReturnValue(transporter);

        const client = new SmtpMailClient();

        expect(client).toBeInstanceOf(SmtpMailClient);
        expect(createTransportSpy).toHaveBeenCalledWith({
            host: "smtp.flipxer.local",
            port: 465,
            secure: true,
            auth: {
                user: "smtp-user",
                pass: "smtp-pass",
            },
        });
    });

    it("maps headers, reply-to, attachments and inline images for sendMail", async () => {
        const transporter = {
            sendMail: jest.fn().mockResolvedValue({ messageId: "message-id" }),
        } as any;
        const client = new SmtpMailClient(transporter);

        await client.sendMail({
            from: { address: "noreply@test.com", name: "Flipxer" },
            to: [{ email_address: { address: "user@test.com" } }],
            cc: [{ email_address: { address: "cc@test.com" } }],
            bcc: [{ email_address: { address: "bcc@test.com" } }],
            reply_to: [{ address: "support@test.com", name: "Support" }],
            subject: "Subject",
            textbody: "Text body",
            htmlbody: "<p>HTML body</p>",
            client_reference: "client-ref-1",
            mime_headers: { "X-Trace-Id": "trace-1" },
            attachments: [
                {
                    content: Buffer.from("file-content").toString("base64"),
                    mime_type: "text/plain",
                    name: "receipt.txt",
                },
                {
                    content: undefined,
                    mime_type: "text/plain",
                    name: "ignored.txt",
                },
            ],
            inline_images: [
                {
                    content: Buffer.from("inline-content").toString("base64"),
                    mime_type: "image/png",
                    cid: "logo-cid",
                },
                {
                    content: undefined,
                    mime_type: "image/png",
                    cid: "ignored-cid",
                },
            ],
        } as never);

        expect(transporter.sendMail).toHaveBeenCalledWith(
            expect.objectContaining({
                cc: ["cc@test.com"],
                bcc: ["bcc@test.com"],
                replyTo: ["Support <support@test.com>"],
                headers: {
                    "X-Trace-Id": "trace-1",
                    "X-Client-Reference": "client-ref-1",
                },
                attachments: [
                    expect.objectContaining({
                        filename: "receipt.txt",
                        contentType: "text/plain",
                    }),
                    expect.objectContaining({
                        filename: "inline-0",
                        contentType: "image/png",
                        cid: "logo-cid",
                    }),
                ],
            })
        );
    });

    it("creates a MailHog-friendly template preview", async () => {
        const transporter = {
            sendMail: jest.fn().mockResolvedValue({ messageId: "message-id" }),
        } as any;
        const client = new SmtpMailClient(transporter);

        await expect(
            client.sendMailWithTemplate({
                from: { address: "noreply@test.com" },
                to: [{ email_address: { address: "user@test.com" } }],
                template_key: "verify_account",
                merge_info: { first_name: "Ada", verification_code: "123456" },
            } as never)
        ).resolves.toEqual({ messageId: "message-id" });

        expect(transporter.sendMail).toHaveBeenCalledWith(
            expect.objectContaining({
                subject: "[Local SMTP] Verify Account",
                to: ["user@test.com"],
                text: expect.stringContaining("verification_code: 123456"),
                html: expect.stringContaining("verify_account"),
            })
        );
    });

    it("maps configured ZeptoMail keys back to readable local preview labels", async () => {
        const transporter = {
            sendMail: jest.fn().mockResolvedValue({ messageId: "message-id" }),
        } as any;
        const client = new SmtpMailClient(transporter);

        await expect(
            client.sendMailWithTemplate({
                from: { address: "noreply@test.com" },
                to: [{ email_address: { address: "user@test.com" } }],
                template_key: "zepto-document-approved-key",
                merge_info: { first_name: "Ada", status: "Approved" },
            } as never)
        ).resolves.toEqual({ messageId: "message-id" });

        expect(transporter.sendMail).toHaveBeenCalledWith(
            expect.objectContaining({
                subject: "[Local SMTP] Document Approved",
                text: expect.stringContaining(
                    "Template key: zepto-document-approved-key"
                ),
                html: expect.stringContaining("zepto-document-approved-key"),
            })
        );
    });

    it.each([
        "document_escalated",
        "document_pending_review",
        "document_rejected",
        "forgot_password",
        "recovery_pin",
        "registration_success",
        "transaction_failed",
        "transaction_notification",
        "transaction_otp",
    ])("renders known local template alias %s", async (templateAlias) => {
        const transporter = {
            sendMail: jest.fn().mockResolvedValue({ messageId: "message-id" }),
        } as any;
        const client = new SmtpMailClient(transporter);

        existsSyncMock.mockReturnValue(true);
        readFileSyncMock.mockReturnValue(
            "<p>{{first_name}}</p><p>{{status}}</p>" as any
        );

        await expect(
            client.sendMailWithTemplate({
                from: { address: "noreply@test.com" },
                to: [{ email_address: { address: "user@test.com" } }],
                template_alias: templateAlias,
                merge_info: {
                    first_name: "Ada",
                    status: "Queued",
                },
            } as never)
        ).resolves.toEqual({ messageId: "message-id" });

        expect(readFileSyncMock).toHaveBeenCalled();
        expect(transporter.sendMail).toHaveBeenCalledWith(
            expect.objectContaining({
                subject: `[Local SMTP] ${templateAlias
                    .split("_")
                    .map(
                        (part) =>
                            part.charAt(0).toUpperCase() +
                            part.slice(1).toLowerCase()
                    )
                    .join(" ")}`,
                html: expect.stringContaining("<p>Ada</p><p>Queued</p>"),
            })
        );
    });

    it("sends batch template previews one recipient at a time", async () => {
        const transporter = {
            sendMail: jest.fn().mockResolvedValue({ messageId: "message-id" }),
        } as any;
        const client = new SmtpMailClient(transporter);

        await expect(
            client.mailBatchWithTemplate({
                from: { address: "noreply@test.com" },
                to: [
                    {
                        email_address: { address: "first@test.com" },
                        merge_info: { first_name: "Ada" },
                    },
                    {
                        email_address: { address: "second@test.com" },
                        merge_info: { first_name: "Grace" },
                    },
                ],
                template_key: "welcome_user",
            } as never)
        ).resolves.toEqual(
            expect.objectContaining({
                total: 2,
                accepted: ["first@test.com", "second@test.com"],
            })
        );

        expect(transporter.sendMail).toHaveBeenCalledTimes(2);
    });

    it("renders a local HTML template, escaping merge values and preserving unknown placeholders", async () => {
        const transporter = {
            sendMail: jest.fn().mockResolvedValue({ messageId: "message-id" }),
        } as any;
        const client = new SmtpMailClient(transporter);

        existsSyncMock.mockReturnValue(true);
        readFileSyncMock.mockImplementation(
            () => "<p>{{first_name}}</p><p>{{missing}}</p><p>{{payload}}</p>" as any
        );

        await client.sendMailWithTemplate({
            from: { address: "noreply@test.com" },
            to: [{ email_address: { address: "user@test.com" } }],
            template_key: "verify_account",
            merge_info: {
                first_name: "Ada & Bob <Admin>",
                payload: { approved: true },
            },
        } as never);

        expect(transporter.sendMail).toHaveBeenCalledWith(
            expect.objectContaining({
                html: expect.stringContaining("Ada &amp; Bob &lt;Admin&gt;"),
                text: expect.stringContaining('payload: {\n  "approved": true\n}'),
            })
        );
        expect(transporter.sendMail).toHaveBeenCalledWith(
            expect.objectContaining({
                html: expect.stringContaining("{{missing}}"),
            })
        );
    });

    it("falls back to a generic preview when a local template cannot be loaded", async () => {
        const transporter = {
            sendMail: jest.fn().mockResolvedValue({ messageId: "message-id" }),
        } as any;
        const client = new SmtpMailClient(transporter);

        existsSyncMock.mockReturnValue(true);
        readFileSyncMock.mockImplementation(() => {
            throw new Error("read failure");
        });

        await client.sendMailWithTemplate({
            from: { address: "noreply@test.com" },
            to: [{ email_address: { address: "user@test.com" } }],
            template_alias: "manual-review",
        } as never);

        expect(transporter.sendMail).toHaveBeenCalledWith(
            expect.objectContaining({
                subject: "[Local SMTP] Manual Review",
                text: expect.stringContaining("No merge fields provided."),
                html: expect.stringContaining("No merge fields provided."),
            })
        );
    });

    it("rejects traversal-like template aliases before resolving a local path", async () => {
        const transporter = {
            sendMail: jest.fn().mockResolvedValue({ messageId: "message-id" }),
        } as any;
        const client = new SmtpMailClient(transporter);

        await client.sendMailWithTemplate({
            from: { address: "noreply@test.com" },
            to: [{ email_address: { address: "user@test.com" } }],
            template_alias: "../secrets/reset-password",
        } as never);

        expect(existsSyncMock).not.toHaveBeenCalled();
        expect(readFileSyncMock).not.toHaveBeenCalled();
        expect(transporter.sendMail).toHaveBeenCalledWith(
            expect.objectContaining({
                subject: "[Local SMTP] Local Template",
                html: expect.stringContaining("Local SMTP preview"),
            })
        );
    });

    it("supports helper fallbacks for empty headers and formatting utilities", () => {
        const client = new SmtpMailClient({ sendMail: jest.fn() } as any);
        const internals = client as any;

        expect(internals.buildHeaders(undefined, undefined)).toBeUndefined();
        expect(internals.formatRecipients(undefined)).toBeUndefined();
        expect(internals.formatReplyTo(undefined)).toBeUndefined();
        expect(internals.serializeValue(null)).toBe("");
        expect(internals.serializeValue(42)).toBe("42");
        expect(internals.serializeValue(false)).toBe("false");
        expect(internals.escapeHtml("&<>\"'")).toBe(
            "&amp;&lt;&gt;&quot;&#39;"
        );
    });
});
