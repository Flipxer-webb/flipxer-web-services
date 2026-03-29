import { MODULE_METADATA } from "@nestjs/common/constants";

const sendMailClientCtor = jest.fn().mockImplementation((options) => ({ options }));

jest.mock("zeptomail", () => ({
    SendMailClient: sendMailClientCtor,
    __esModule: true,
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
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("registers EmailService provider and builds it with SendMailClient", () => {
        const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, EmailModule) as Array<{
            provide: unknown;
            useFactory: () => unknown;
        }>;
        const exportsMeta = Reflect.getMetadata(MODULE_METADATA.EXPORTS, EmailModule) as unknown[];

        expect(providers).toHaveLength(1);
        expect(providers[0].provide).toBe(EmailService);
        expect(exportsMeta).toEqual([EmailService]);

        const service = providers[0].useFactory();

        expect(sendMailClientCtor).toHaveBeenCalledWith({
            url: "https://mail.example",
            token: "mail-token",
        });
        expect(service).toBeInstanceOf(EmailService);
    });
});
