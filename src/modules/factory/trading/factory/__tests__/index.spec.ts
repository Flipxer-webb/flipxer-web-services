import { Logger } from "@nestjs/common";

const quidaxLibCtor = jest.fn().mockImplementation((options) => ({ options }));
const quidaxServiceCtor = jest.fn().mockImplementation((quidax) => ({ quidax, type: "service" }));
const tradingProviderCtor = jest.fn().mockImplementation((service) => ({ service, type: "provider" }));

jest.mock("@/libs/quidax", () => ({
    QuidaxLib: quidaxLibCtor,
    __esModule: true,
}));

jest.mock("../../providers/quidax/services", () => ({
    QuidaxService: quidaxServiceCtor,
    __esModule: true,
}));

jest.mock("../../providers/quidax/quidax-trading-provider", () => ({
    QuidaxTradingProvider: tradingProviderCtor,
    __esModule: true,
}));

const safeProviderCtor = jest.fn().mockImplementation((inner, env) => ({ inner, env, type: "safe-provider" }));
jest.mock("../../providers/safe/safe-trading-provider", () => ({
    SafeQuidaxTradingProvider: safeProviderCtor,
    __esModule: true,
}));

const mockProviderCtor = jest.fn().mockImplementation(() => ({ type: "mock-provider" }));
jest.mock("../../providers/mock/mock-trading-provider", () => ({
    MockQuidaxTradingProvider: mockProviderCtor,
    __esModule: true,
}));

import { TradingFactory } from "../index";

describe("TradingFactory", () => {
    const tradingConfig = {
        quidax: {
            api_public: "public-key",
            api_secret: "secret-key",
            baseUrl: "https://api.quidax.test",
            rampBaseUrl: "https://ramp.quidax.test",
        },
    } as any;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("buildQuidaxService creates QuidaxLib and QuidaxService", () => {
        const requestBudget = { assertAllowed: jest.fn(), noteThrottle: jest.fn() };
        const factory = new TradingFactory(tradingConfig, requestBudget as any);

        const service = factory.buildQuidaxService() as any;

        expect(quidaxLibCtor).toHaveBeenCalledWith({
            api_public: "public-key",
            api_secret: "secret-key",
            baseURL: "https://api.quidax.test",
            rampBaseURL: "https://ramp.quidax.test",
            requestBudget,
        });
        expect(quidaxServiceCtor).toHaveBeenCalledWith(
            expect.objectContaining({
                options: expect.any(Object),
            })
        );
        expect(service.type).toBe("service");
    });

    it("buildQuidaxService returns service for configured provider", () => {
        const factory = new TradingFactory(tradingConfig);

        const service = factory.buildQuidaxService() as any;

        expect(service.type).toBe("service");
        expect(quidaxServiceCtor).toHaveBeenCalledTimes(1);
    });

    it("buildProvider returns provider wrapper for quidax", () => {
        const factory = new TradingFactory(tradingConfig);

        const provider = factory.buildProvider({ provider: "quidax" } as any) as any;

        expect(tradingProviderCtor).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "service",
            })
        );
        expect(safeProviderCtor).toHaveBeenCalledWith(
            expect.objectContaining({ type: "provider" }),
            expect.any(String),
        );
        expect(provider.type).toBe("safe-provider");
    });

    it("buildProvider throws for unknown provider", () => {
        const factory = new TradingFactory(tradingConfig);

        expect(() => factory.buildProvider({ provider: "unknown" } as any)).toThrow(
            "Unknown provider: unknown"
        );
    });

    it("build returns QuidaxService for quidax provider", () => {
        const factory = new TradingFactory(tradingConfig);

        const service = factory.build({ provider: "quidax" } as any) as any;

        expect(service.type).toBe("service");
    });

    it("build throws for unknown provider", () => {
        const factory = new TradingFactory(tradingConfig);

        expect(() => factory.build({ provider: "unknown" } as any)).toThrow(
            "Unknown provider: unknown"
        );
    });

    it("buildProvider returns mock provider when QUIDAX_MOCK=true", () => {
        const origMock = process.env.QUIDAX_MOCK;
        process.env.QUIDAX_MOCK = "true";
        try {
            const factory = new TradingFactory(tradingConfig);
            const provider = factory.buildProvider({ provider: "quidax" } as any) as any;

            expect(mockProviderCtor).toHaveBeenCalled();
            expect(provider.type).toBe("mock-provider");
        } finally {
            process.env.QUIDAX_MOCK = origMock;
        }
    });

    it("buildProvider returns raw provider in production", () => {
        const origEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = "production";
        try {
            const factory = new TradingFactory(tradingConfig);
            const provider = factory.buildProvider({ provider: "quidax" } as any) as any;

            expect(safeProviderCtor).not.toHaveBeenCalled();
            expect(provider.type).toBe("provider");
        } finally {
            process.env.NODE_ENV = origEnv;
        }
    });

    it("logs missing config details when baseUrl or secret is absent", () => {
        const loggerErrorSpy = jest
            .spyOn(Logger.prototype, "error")
            .mockImplementation(() => undefined);

        const factory = new TradingFactory({
            quidax: {
                baseUrl: "",
                rampBaseUrl: "",
                api_public: "",
                api_secret: "",
            },
        } as any);

        factory.buildQuidaxService();

        expect(loggerErrorSpy).toHaveBeenCalled();
        loggerErrorSpy.mockRestore();
    });
});
