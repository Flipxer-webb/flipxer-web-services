import { EmailService } from "../index";

describe("EmailService", () => {
    let client: {
        sendMail: jest.Mock;
        sendMailWithTemplate: jest.Mock;
        mailBatchWithTemplate: jest.Mock;
    };
    let service: EmailService;

    beforeEach(() => {
        client = {
            sendMail: jest.fn(),
            sendMailWithTemplate: jest.fn(),
            mailBatchWithTemplate: jest.fn(),
        };

        service = new EmailService(client as never);
    });

    it("delegates sendMail", async () => {
        client.sendMail.mockResolvedValue({ accepted: ["user@test.com"] });

        await expect(service.sendMail({ to: [{ email_address: { address: "user@test.com" } }] } as never)).resolves.toEqual({
            accepted: ["user@test.com"],
        });
    });

    it("delegates sendBatchMail", async () => {
        client.mailBatchWithTemplate.mockResolvedValue({ total: 2 });

        await expect(service.sendBatchMail({ mail_template_key: "template" } as never)).resolves.toEqual({ total: 2 });
    });

    it("logs and returns sendMailWithTemplate success", async () => {
        client.sendMailWithTemplate.mockResolvedValue({ request_id: "req-1" });
        const logSpy = jest.spyOn((service as any).logger, "log").mockImplementation(() => undefined);

        await expect(
            service.sendMailWithTemplate({ to: [{ email_address: { address: "ok@test.com" } }], template_key: "welcome" } as never),
        ).resolves.toEqual({ request_id: "req-1" });
        expect(logSpy).toHaveBeenCalled();

        // Verify template_key is remapped to mail_template_key for ZeptoMail
        const passedOptions = client.sendMailWithTemplate.mock.calls[0][0];
        expect(passedOptions.mail_template_key).toBe("welcome");
        expect(passedOptions.template_key).toBeUndefined();
    });

    it("logs and rethrows sendMailWithTemplate errors", async () => {
        const err = new Error("template send failed");
        client.sendMailWithTemplate.mockRejectedValue(err);
        const errorSpy = jest.spyOn((service as any).logger, "error").mockImplementation(() => undefined);

        await expect(
            service.sendMailWithTemplate({ to: [{ email_address: { address: "bad@test.com" } }], template_key: "x" } as never),
        ).rejects.toThrow("template send failed");
        expect(errorSpy).toHaveBeenCalled();
    });
});