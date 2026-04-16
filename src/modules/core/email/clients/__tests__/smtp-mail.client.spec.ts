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

import { SmtpMailClient } from "../smtp-mail.client";

describe("SmtpMailClient", () => {
    beforeEach(() => {
        jest.spyOn(console, "log").mockImplementation(() => undefined);
    });

    afterEach(() => {
        (console.log as jest.Mock).mockRestore();
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
                html: expect.stringContaining(
                    "zepto-document-approved-key"
                ),
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
});