const helmetMock = jest.fn(() => "helmet-middleware");
const compressionMock = jest.fn(() => "compression-middleware");
const morganMock = jest.fn(() => "morgan-middleware");
const waitForRedisMock = jest.fn();
const classValidatorPipeInstanceMock = jest.fn(() => ({ pipe: true }));
const enableShutdownHooksMock = jest.fn();
const randomBytesMock = jest.fn(() => ({ toString: () => "nonce-value" }));

const configState = {
    frontendDevOrigin: "http://localhost:3000",
    isProdEnvironment: false,
    redisConfig: { host: "redis-host", port: 6379 },
};

const expressOptionsMock = jest.fn();
const expressUseMock = jest.fn();
const expressPostMock = jest.fn();

const expressInstance = {
    options: expressOptionsMock,
    use: expressUseMock,
    post: expressPostMock,
};

const appMock = {
    set: jest.fn(),
    use: jest.fn(),
    enableCors: jest.fn(),
    useBodyParser: jest.fn(),
    enableVersioning: jest.fn(),
    useGlobalPipes: jest.fn(),
    useGlobalFilters: jest.fn(),
    listen: jest.fn(),
    getHttpAdapter: jest.fn(() => ({
        getInstance: () => expressInstance,
    })),
    get: jest.fn(),
};

class MockHttpAdapterHost {}
class MockPrismaService {}

const NestFactoryMock = {
    create: jest.fn(async () => appMock),
};

const setupSwaggerMock = jest.fn();
const createSwaggerDocumentMock = jest.fn(() => ({ openapi: "3.0.0" }));

class DocumentBuilderMock {
    setTitle() {
        return this;
    }

    setDescription() {
        return this;
    }

    setVersion() {
        return this;
    }

    addBearerAuth() {
        return this;
    }

    build() {
        return { info: { title: "mock" } };
    }
}

jest.mock("helmet", () => ({
    __esModule: true,
    default: helmetMock,
}));

jest.mock("compression", () => ({
    __esModule: true,
    default: compressionMock,
}));

jest.mock("morgan", () => ({
    __esModule: true,
    default: morganMock,
}));

jest.mock("node:crypto", () => ({
    randomBytes: randomBytesMock,
}));

jest.mock("@nestjs/core", () => ({
    __esModule: true,
    HttpAdapterHost: MockHttpAdapterHost,
    NestFactory: NestFactoryMock,
}));

jest.mock("@nestjs/swagger", () => ({
    __esModule: true,
    DocumentBuilder: DocumentBuilderMock,
    SwaggerModule: {
        setup: setupSwaggerMock,
        createDocument: createSwaggerDocumentMock,
    },
}));

jest.mock("@/modules", () => ({
    __esModule: true,
    AppModule: class MockAppModule {},
}));

jest.mock("@/core/exception/http", () => ({
    __esModule: true,
    AllExceptionsFilter: class AllExceptionsFilter {
        constructor(public readonly host: unknown) {}
    },
}));

jest.mock("@/core/pipe", () => ({
    __esModule: true,
    classValidatorPipeInstance: classValidatorPipeInstanceMock,
}));

jest.mock("@/modules/core/prisma/services", () => ({
    __esModule: true,
    PrismaService: MockPrismaService,
}));

jest.mock("@/utils", () => ({
    __esModule: true,
    waitForRedis: waitForRedisMock,
}));

jest.mock("@/config", () => ({
    __esModule: true,
    get frontendDevOrigin() {
        return configState.frontendDevOrigin;
    },
    get isProdEnvironment() {
        return configState.isProdEnvironment;
    },
    get redisConfig() {
        return configState.redisConfig;
    },
}));

import createServer from "../index";

describe("createServer", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        configState.isProdEnvironment = false;
        process.env.NODE_ENV = "test";

        appMock.get.mockImplementation((token: unknown) => {
            if (token === MockHttpAdapterHost) {
                return { adapter: "host" };
            }
            if (token === MockPrismaService) {
                return {
                    enableShutdownHooks: enableShutdownHooksMock,
                };
            }
            return undefined;
        });
    });

    it("boots app with middleware, swagger setup, and shutdown hooks", async () => {
        const app = await createServer({
            port: 4010,
            production: false,
            whitelistedDomains: ["https://allowed.app"],
        });

        expect(app).toBe(appMock);
        expect(NestFactoryMock.create).toHaveBeenCalled();
        expect(appMock.set).toHaveBeenCalledWith("trust proxy", true);
        expect(appMock.use).toHaveBeenCalledWith("helmet-middleware");
        expect(appMock.use).toHaveBeenCalledWith("compression-middleware");
        expect(appMock.use).toHaveBeenCalledWith("morgan-middleware");
        expect(morganMock).toHaveBeenCalledWith("dev");
        expect(appMock.useBodyParser).toHaveBeenCalledWith("json", {
            limit: "10mb",
        });

        expect(appMock.enableCors).toHaveBeenCalledWith(
            expect.objectContaining({
                origin: ["https://allowed.app", "http://localhost:3000"],
                credentials: true,
            })
        );

        expect(createSwaggerDocumentMock).toHaveBeenCalled();
        expect(setupSwaggerMock).toHaveBeenCalledWith("api", appMock, {
            openapi: "3.0.0",
        });

        expect(waitForRedisMock).toHaveBeenCalledWith(configState.redisConfig);
        expect(appMock.listen).toHaveBeenCalledWith(4010);
        expect(enableShutdownHooksMock).toHaveBeenCalledWith(appMock);
    });

    it("skips swagger setup in production node env", async () => {
        process.env.NODE_ENV = "production";

        await createServer({
            port: 4011,
            production: true,
            whitelistedDomains: ["https://allowed.app"],
        });

        expect(setupSwaggerMock).not.toHaveBeenCalled();
        expect(morganMock).toHaveBeenCalledWith("combined");
    });

    it("handles CORS preflight: allowed origin returns 204, disallowed returns 403", async () => {
        await createServer({
            port: 4012,
            whitelistedDomains: ["https://allowed.app"],
        });

        const optionsHandler = expressOptionsMock.mock.calls[0][1];

        const makeRes = () => ({
            header: jest.fn(),
            sendStatus: jest.fn(),
        });

        const allowedRes = makeRes();
        optionsHandler({ headers: { origin: "https://allowed.app" } }, allowedRes);
        expect(allowedRes.header).toHaveBeenCalledWith(
            "Access-Control-Allow-Origin",
            "https://allowed.app"
        );
        expect(allowedRes.sendStatus).toHaveBeenCalledWith(204);

        const disallowedRes = makeRes();
        optionsHandler({ headers: { origin: "https://evil.app" } }, disallowedRes);
        expect(disallowedRes.sendStatus).toHaveBeenCalledWith(403);

        const noOriginRes = makeRes();
        optionsHandler({ headers: {} }, noOriginRes);
        expect(noOriginRes.sendStatus).toHaveBeenCalledWith(204);
    });

    it("registers webhook forwarding handlers with expected rewrites", async () => {
        await createServer({
            port: 4013,
            whitelistedDomains: [],
        });

        const routeHandlers = new Map<string, Function>();
        for (const [route, handler] of expressPostMock.mock.calls) {
            routeHandlers.set(route as string, handler as Function);
        }

        const rootHandler = routeHandlers.get("/");
        const fincraApiHandler = routeHandlers.get("/api/webhook/fincra");
        const quidaxHandler = routeHandlers.get("/quidax");
        const quidaxApiHandler = routeHandlers.get("/api/webhook/quidax");

        expect(rootHandler).toBeDefined();
        expect(fincraApiHandler).toBeDefined();
        expect(quidaxHandler).toBeDefined();
        expect(quidaxApiHandler).toBeDefined();

        const fincraReq = { headers: { "x-fincra-signature": "sig" }, url: "/" } as any;
        const fincraNext = jest.fn();
        rootHandler!(fincraReq, {} as any, fincraNext);
        expect(fincraReq.url).toBe("/webhook/fincra");
        expect(fincraNext).toHaveBeenCalled();

        const nonFincraReq = { headers: {}, url: "/" } as any;
        const nonFincraNext = jest.fn();
        rootHandler!(nonFincraReq, {} as any, nonFincraNext);
        expect(nonFincraReq.url).toBe("/");
        expect(nonFincraNext).toHaveBeenCalled();

        const fincraApiReq = { headers: {}, url: "/api/webhook/fincra" } as any;
        const fincraApiNext = jest.fn();
        fincraApiHandler!(fincraApiReq, {} as any, fincraApiNext);
        expect(fincraApiReq.url).toBe("/webhook/fincra");

        const quidaxReq = { headers: {}, url: "/quidax" } as any;
        const quidaxNext = jest.fn();
        quidaxHandler!(quidaxReq, {} as any, quidaxNext);
        expect(quidaxReq.url).toBe("/webhook/quidax");

        const quidaxApiReq = { headers: {}, url: "/api/webhook/quidax" } as any;
        const quidaxApiNext = jest.fn();
        quidaxApiHandler!(quidaxApiReq, {} as any, quidaxApiNext);
        expect(quidaxApiReq.url).toBe("/webhook/quidax");
    });

    it("adds CSP nonce through express middleware", async () => {
        await createServer({
            port: 4014,
            whitelistedDomains: [],
        });

        const nonceMiddleware = expressUseMock.mock.calls[0][0];
        const res = { locals: {} as Record<string, string> };
        const next = jest.fn();

        nonceMiddleware({} as any, res as any, next);

        expect(randomBytesMock).toHaveBeenCalledWith(16);
        expect(res.locals.cspNonce).toBe("nonce-value");
        expect(next).toHaveBeenCalled();
    });
});
