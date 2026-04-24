import { AllExceptionsFilter } from "@/core/exception/http";
import { classValidatorPipeInstance } from "@/core/pipe";
import { AuthGuard, TwoFactorGuard } from "@/modules/api/auth/guard";
import { PrismaService } from "@/modules/core/prisma/services";
import { RateLimiterGuard } from "@/modules/core/rate-limit/guards/rate-limiter.guard";
import { RateService } from "@/modules/api/trade/services/rate.service";
import { HttpAdapterHost } from "@nestjs/core";
import {
    CanActivate,
    ExecutionContext,
    INestApplication,
    VersioningType,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Test, TestingModule } from "@nestjs/testing";
import request from "supertest";

import { SettingService } from "../../../services";
import { SettingController } from "../index";

jest.mock("@/modules/api/auth/guard", () => {
    const actual = jest.requireActual("@/modules/api/auth/guard");

    return {
        ...actual,
        AuthGuard: class {
            readonly __stub = true;

            canActivate(context: ExecutionContext) {
                const request = context.switchToHttp().getRequest();
                request.user = { id: 77 };
                return true;
            }
        },
        __esModule: true,
    };
});

jest.mock("@/modules/api/trade/services/rate.service", () => ({
    RateService: class RateServiceStub {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("../../../services", () => ({
    SettingService: class SettingServiceStub {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("@/modules/api/user/decorators", () => {
    const { createParamDecorator } = jest.requireActual("@nestjs/common");

    return {
        User: createParamDecorator((data: string, ctx: ExecutionContext) => {
            const request = ctx.switchToHttp().getRequest();
            const user = request.user;
            return data ? user?.[data] : user;
        }),
        ClientData: createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
            const request = ctx.switchToHttp().getRequest();
            return { ipAddress: request.ip };
        }),
        __esModule: true,
    };
});

jest.mock("@/modules/api/trade/gateway/v1", () => ({
    WsGateway: class { server = { to: jest.fn() }; },
    __esModule: true,
}));

jest.mock("@/modules/core/rate-limit/guards/rate-limiter.guard", () => ({
    RateLimiterGuard: class {
        readonly __stub = true;

        canActivate() {
            return true;
        }
    },
    RateLimit: () => () => undefined,
    StrictRateLimit: () => () => undefined,
    __esModule: true,
}));

jest.mock("@/config", () => ({
    jwtSecret: "test-jwt-value",
    quidaxConfig: { webhook_key: "test-hmac-value" },
    blockedCountries: ["KP", "IR"],
    isProduction: false,
    isProdEnvironment: false,
    __esModule: true,
}));

describe("POST /api/v1/settings/security/backup-codes integration", () => {
    let app: INestApplication;
    let consoleErrorSpy: jest.SpyInstance;
    let settingService: {
        generateNewBackupCodes: jest.Mock;
    };
    let prismaService: {
        user: {
            findUnique: jest.Mock;
        };
    };

    beforeAll(async () => {
        settingService = {
            generateNewBackupCodes: jest.fn(),
        };

        prismaService = {
            user: {
                findUnique: jest.fn(),
            },
        };

        const module: TestingModule = await Test.createTestingModule({
            controllers: [SettingController],
            providers: [
                TwoFactorGuard,
                {
                    provide: SettingService,
                    useValue: settingService,
                },
                {
                    provide: RateService,
                    useValue: {
                        getAllRates: jest.fn(),
                        getAssetRate: jest.fn(),
                    },
                },
                {
                    provide: PrismaService,
                    useValue: prismaService,
                },
                {
                    provide: JwtService,
                    useValue: {
                        verifyAsync: jest.fn(),
                    },
                },
                {
                    provide: AuthGuard,
                    useValue: {
                        canActivate(context: ExecutionContext) {
                            const request = context.switchToHttp().getRequest();
                            request.user = { id: 77 };
                            return true;
                        },
                    } satisfies CanActivate,
                },
                {
                    provide: RateLimiterGuard,
                    useValue: {
                        canActivate() {
                            return true;
                        },
                    } satisfies CanActivate,
                },
            ],
        }).compile();

        app = module.createNestApplication();
        app.enableVersioning({
            type: VersioningType.URI,
            defaultVersion: "1",
            prefix: "api/v",
        });
        app.useGlobalPipes(classValidatorPipeInstance());
        app.useGlobalFilters(new AllExceptionsFilter(app.get(HttpAdapterHost)));
        await app.init();
    });

    beforeEach(() => {
        jest.clearAllMocks();
        consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
        prismaService.user.findUnique.mockResolvedValue({
            twoFactorSecret: null,
            isTwoFactorEnabled: false,
            tier: 1,
            securityMethods: { email: true },
            requiredMethodCount: 1,
            tradingPassword: null,
            isPhoneVerified: false,
            isEmailVerified: true,
        });
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
    });

    afterAll(async () => {
        if (app) {
            await app.close();
        }
    });

    it("returns SECURITY_VERIFICATION_REQUIRED when verification token is missing", async () => {
        const response = await request(app.getHttpServer())
            .post("/api/v1/settings/security/backup-codes")
            .send({});

        expect(response.status).toBe(403);
        expect(response.body.success).toBe(false);
        expect(response.body.message).toContain("SECURITY_VERIFICATION_REQUIRED");
        const guardPayload = JSON.parse(response.body.message);

        expect(guardPayload).toEqual(
            expect.objectContaining({
                code: "SECURITY_VERIFICATION_REQUIRED",
                message: "Security verification is required for this transaction",
                requiredCount: 1,
            }),
        );
        expect(guardPayload.availableMethods).toEqual(
            expect.arrayContaining(["email", "backupCode"]),
        );
        expect(settingService.generateNewBackupCodes).not.toHaveBeenCalled();
    });
});