import { MODULE_METADATA } from "@nestjs/common/constants";

const smtpMailClientCtor = jest.fn().mockImplementation(() => ({ kind: "smtp" }));
const zeptoMailClientCtor = jest.fn().mockImplementation((options) => ({
    kind: "zepto",
    options,
}));

jest.mock("../clients/smtp-mail.client", () => ({
    SmtpMailClient: smtpMailClientCtor,
}));

jest.mock("../clients/zeptomail.client", () => ({
    ZeptoMailClient: zeptoMailClientCtor,
}));

jest.mock("@/config", () => ({
    mailConfig: {
        url: "https://mail.example",
        token: "mail-token",
    },
    __esModule: true,
}));

import { EmailModule } from "../index";
import { EmailService } from "../services";

describe("EmailModule", () => {
    const originalMailDriver = process.env.MAIL_DRIVER;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    afterEach(() => {
        process.env.MAIL_DRIVER = originalMailDriver;
    });

    it("registers EmailService provider and builds it with ZeptoMailClient", () => {
        delete process.env.MAIL_DRIVER;

        const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, EmailModule) as Array<{
            provide: unknown;
            useFactory: () => unknown;
        }>;
        const exportsMeta = Reflect.getMetadata(MODULE_METADATA.EXPORTS, EmailModule) as unknown[];

        expect(providers).toHaveLength(1);
        expect(providers[0].provide).toBe(EmailService);
        expect(exportsMeta).toEqual([EmailService]);

        const service = providers[0].useFactory();

        expect(zeptoMailClientCtor).toHaveBeenCalledWith({
            url: "https://mail.example",
            token: "mail-token",
        });
        expect(service).toBeInstanceOf(EmailService);
    });

    it("builds EmailService with SmtpMailClient when MAIL_DRIVER is smtp", () => {
        process.env.MAIL_DRIVER = "smtp";

        const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, EmailModule) as Array<{
            provide: unknown;
            useFactory: () => unknown;
        }>;

        const service = providers[0].useFactory();

        expect(smtpMailClientCtor).toHaveBeenCalledTimes(1);
        expect(zeptoMailClientCtor).not.toHaveBeenCalled();
        expect(service).toBeInstanceOf(EmailService);
    });
});
