const mockLoggerLog = jest.fn();
const mockLoggerError = jest.fn();
const mockQuidaxLib = jest.fn();
const mockQuidaxService = jest.fn();
const mockQuidaxTradingProvider = jest.fn();

jest.mock("@nestjs/common", () => ({
    Logger: jest.fn().mockImplementation(() => ({
        log: mockLoggerLog,
        error: mockLoggerError,
    })),
}));

jest.mock("@/libs/quidax", () => ({
    QuidaxLib: mockQuidaxLib,
}));

jest.mock("../../providers/quidax/services", () => ({
    QuidaxService: mockQuidaxService,
}));

jest.mock("../../providers/quidax/quidax-trading-provider", () => ({
    QuidaxTradingProvider: mockQuidaxTradingProvider,
}));

import { TradingFactory } from "../index";

describe("TradingFactory", () => {
    const validConfig = {
        quidax: {
            api_public: "public-key",
            api_secret: "secret-key",
            baseUrl: "https://api.quidax.com",
            rampBaseUrl: "https://ramp.quidax.com",
        },
    } as any;

    beforeEach(() => {
        jest.clearAllMocks();
        mockQuidaxLib.mockImplementation((options) => ({ __type: "quidax-lib", options }));
        mockQuidaxService.mockImplementation((quidax) => ({ __type: "quidax-service", quidax }));
        mockQuidaxTradingProvider.mockImplementation((service) => ({ __type: "provider", service }));
    });

    it("buildQuidaxService should create and return QuidaxService", () => {
        const factory = new TradingFactory(validConfig);

        const result = factory.buildQuidaxService();

        expect(mockQuidaxLib).toHaveBeenCalledWith({
            api_public: "public-key",
            api_secret: "secret-key",
            baseURL: "https://api.quidax.com",
            rampBaseURL: "https://ramp.quidax.com",
        });
        expect(mockQuidaxService).toHaveBeenCalledTimes(1);
        expect(result).toEqual({
            __type: "quidax-service",
            quidax: {
                __type: "quidax-lib",
                options: {
                    api_public: "public-key",
                    api_secret: "secret-key",
                    baseURL: "https://api.quidax.com",
                    rampBaseURL: "https://ramp.quidax.com",
                },
            },
        });
    });

    it("build should throw for unknown provider", () => {
        const factory = new TradingFactory(validConfig);

        expect(() => (factory as any).build({ provider: "unknown" })).toThrow(
            "Unknown provider: unknown"
        );
    });

    it("buildProvider should return QuidaxTradingProvider for quidax", () => {
        const factory = new TradingFactory(validConfig);

        const result = factory.buildProvider({ provider: "quidax" } as any);

        expect(mockQuidaxTradingProvider).toHaveBeenCalledTimes(1);
        expect(result).toEqual({
            __type: "provider",
            service: {
                __type: "quidax-service",
                quidax: {
                    __type: "quidax-lib",
                    options: {
                        api_public: "public-key",
                        api_secret: "secret-key",
                        baseURL: "https://api.quidax.com",
                        rampBaseURL: "https://ramp.quidax.com",
                    },
                },
            },
        });
    });

    it("buildProvider should throw for unknown provider", () => {
        const factory = new TradingFactory(validConfig);

        expect(() => factory.buildProvider({ provider: "unknown" } as any)).toThrow(
            "Unknown provider: unknown"
        );
    });

    it("should log config error when required values are missing", () => {
        const missingConfig = {
            quidax: {
                api_public: "public-key",
                api_secret: "",
                baseUrl: "",
                rampBaseUrl: "https://ramp.quidax.com",
            },
        } as any;
        const factory = new TradingFactory(missingConfig);

        factory.buildQuidaxService();

        expect(mockLoggerLog).toHaveBeenCalled();
        expect(mockLoggerError).toHaveBeenCalled();
    });
});

