const dotenvConfigMock = jest.fn();
const validateMock = jest.fn();

jest.mock("dotenv", () => ({
    __esModule: true,
    config: dotenvConfigMock,
}));

jest.mock("@boxpositron/vre", () => ({
    __esModule: true,
    default: validateMock,
    RequiredEnvironmentTypes: {
        Number: "number",
        String: "string",
    },
}));

describe("config module", () => {
    const originalEnv = process.env;

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        process.env = { ...originalEnv };

        jest.spyOn(console, "log").mockImplementation(() => undefined);
        jest.spyOn(console, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
        (console.log as jest.Mock).mockRestore();
        (console.error as jest.Mock).mockRestore();
        process.env = originalEnv;
    });

    const loadConfig = (overrides: Record<string, string | undefined> = {}) => {
        process.env = {
            ...originalEnv,
            NODE_ENV: "test",
            PORT: "4000",
            DATABASE_URL: "postgres://db",
            ALLOWED_DOMAINS: "https://app.flipxer.com,https://admin.flipxer.com",
            ZEPTOMAIL_URL: "https://zepto",
            ZEPTOMAIL_SENDER: "mail@flipxer.com",
            REGISTRATION_SUCCESS_TEMPLATE: "reg-template",
            VERIFY_ACCOUNT_TEMPLATE: "verify-template",
            RECOVERY_PIN_TEMPLATE: "recovery-template",
            TRANSACTION_NOTIFICATION_TEMPLATE: "txn-template",
            FAILED_TRANSACTION_TEMPLATE: "failed-template",
            ADMIN_INVITE_TEMPLATE: "admin-invite-template",
            FRONTEND_DEV_DOMAIN: "http://localhost:3000",
            PROFILE_DIR: "profiles",
            DOCUMENT_DIR: "documents",
            ENVIRONMENT: "staging",
            REDIS_HOST: "redis.local",
            REDIS_PORT: "6379",
            REDIS_USER: "default",
            FRONTEND_URL: "https://frontend.flipxer.com",
            ...overrides,
        };

        let loaded: any;
        jest.isolateModules(() => {
            loaded = require("../index");
        });
        return loaded;
    };

    it("loads dotenv and skips runtime validator in test env", () => {
        loadConfig();

        expect(dotenvConfigMock).toHaveBeenCalled();
        expect(validateMock).not.toHaveBeenCalled();
    });

    it("parses allowed domains and exposes whitelist", () => {
        const cfg = loadConfig({
            ALLOWED_DOMAINS: "https://a.com,https://b.com",
        });

        expect(cfg.allowedDomains).toEqual(["https://a.com", "https://b.com"]);
        expect(cfg.whitelist).toEqual(["https://a.com", "https://b.com"]);
    });

    it("normalizes blocked countries and configures redis tls", () => {
        const cfg = loadConfig({
            BLOCKED_COUNTRIES: "ng, us,ca",
            REDIS_TLS: "true",
            REDIS_PORT: "6380",
        });

        expect(cfg.blockedCountries).toEqual(["NG", "US", "CA"]);
        expect(cfg.redisConfig.port).toBe(6380);
        expect(cfg.redisConfig.redisOptions.tls).toEqual({});
    });

    it("uses fallback defaults for optional integrations", () => {
        const cfg = loadConfig({
            FINCRA_BASE_URL: undefined,
            SENDCHAMP_BASE_URL: undefined,
            SENDCHAMP_SENDER_ID: undefined,
            NOMBA_BASE_URL: undefined,
        });

        expect(cfg.fincraOptions.baseUrl).toBe("https://api.fincra.com");
        expect(cfg.sendchampConfig.baseUrl).toBe("https://api.sendchamp.com/api/v1");
        expect(cfg.sendchampConfig.senderId).toBe("Flipxer");
        expect(cfg.nombaOptions.baseUrl).toBe("https://api.nomba.com");
        expect(cfg.sellPayoutProvider).toBe("fincra");
        expect(cfg.buyPaymentProvider).toBe("nomba");
    });

    it("throws when SELL_PAYOUT_PROVIDER is invalid", () => {
        expect(() =>
            loadConfig({
                SELL_PAYOUT_PROVIDER: "stripe",
            })
        ).toThrow("Invalid SELL_PAYOUT_PROVIDER");
    });

    it("throws when BUY_PAYMENT_PROVIDER is invalid", () => {
        expect(() =>
            loadConfig({
                BUY_PAYMENT_PROVIDER: "flutterwave",
            })
        ).toThrow("Invalid BUY_PAYMENT_PROVIDER");
    });

    it("builds template and mail configs from env", () => {
        const cfg = loadConfig({
            DOCUMENT_APPROVED_TEMPLATE: "approved-template",
            DOCUMENT_REJECTED_TEMPLATE: "rejected-template",
        });

        expect(cfg.mailConfig).toEqual({
            url: "https://zepto",
            token: undefined,
            senderMail: "mail@flipxer.com",
        });

        expect(cfg.emailTemplateConfig).toEqual(
            expect.objectContaining({
                registration_success: "reg-template",
                verify_account: "verify-template",
                document_approved: "approved-template",
                document_rejected: "rejected-template",
            })
        );
    });
});
