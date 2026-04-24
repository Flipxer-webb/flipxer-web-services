const buildResponseMock = jest.fn((payload) => payload);

jest.mock("@/modules/api/auth/services", () => ({
    AuthService: class AuthService {},
    __esModule: true,
}));

jest.mock("@/modules/api/auth/services/tier.service", () => ({
    TierService: class TierService {},
    __esModule: true,
}));

jest.mock("@/modules/api/auth/guard", () => ({
    CountryBlockGuard: class CountryBlockGuard {},
    AuthGuard: class AuthGuard {},
    EnabledAccountGuard: class EnabledAccountGuard {},
    SocketAuthGuard: class SocketAuthGuard {},
    __esModule: true,
}));

jest.mock("@/modules/api/user", () => ({
    ClientData: () => () => undefined,
    User: () => () => undefined,
    UserModule: class UserModule {},
    AccountDeletedException: class AccountDeletedException extends Error {},
    UserNotFoundException: class UserNotFoundException extends Error {},
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/guards/role.guard", () => ({
    RoleGuard: class RoleGuard {},
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/decorator", () => ({
    UserTypes: () => () => undefined,
    ADMIN_USER_TYPES: ["SUPER_ADMIN"],
    __esModule: true,
}));

jest.mock("@/modules/core/rate-limit", () => ({
    RateLimiterGuard: class RateLimiterGuard {},
    RateLimit: () => () => undefined,
    __esModule: true,
}));

jest.mock("@/utils/api-response-util", () => ({
    buildResponse: buildResponseMock,
    __esModule: true,
}));

import { AdminAuthController } from "../admin";

describe("AdminAuthController", () => {
    let controller: AdminAuthController;
    let authService: { adminSignIn: jest.Mock; reset2FARateLimit: jest.Mock };
    let tierService: { updateAllUserTiers: jest.Mock };

    const mockAuditLogService = { log: jest.fn().mockResolvedValue(undefined) };
    const mockReq = { ip: '127.0.0.1', headers: { 'user-agent': 'test' }, user: { id: 1 } } as any;

    beforeEach(() => {
        authService = {
            adminSignIn: jest.fn(),
            reset2FARateLimit: jest.fn(),
        };
        tierService = {
            updateAllUserTiers: jest.fn(),
        };

        controller = new AdminAuthController(authService as never, tierService as never, mockAuditLogService as never);
        jest.clearAllMocks();
    });

    it("delegates admin login with client IP", async () => {
        authService.adminSignIn.mockResolvedValue({ accessToken: "token" });

        await expect(
            controller.signIn({ email: "admin@flipxer.com" } as never, { ipAddress: "1.2.3.4" } as never),
        ).resolves.toEqual({ accessToken: "token" });

        expect(authService.adminSignIn).toHaveBeenCalledWith(
            { email: "admin@flipxer.com" },
            "1.2.3.4",
        );
    });

    it("delegates reset2FARateLimit", async () => {
        authService.reset2FARateLimit.mockResolvedValue({ ok: true });

        await expect(controller.reset2FARateLimit({ userId: 7 } as never, mockReq as never)).resolves.toEqual({ ok: true });
        expect(authService.reset2FARateLimit).toHaveBeenCalledWith({ userId: 7 });
        expect(mockAuditLogService.log).toHaveBeenCalledWith(
            expect.objectContaining({ action: "RESET_2FA_RATE_LIMIT", resource: "user" }),
        );
    });

    it("updates all user tiers and builds response", async () => {
        tierService.updateAllUserTiers.mockResolvedValue({ updated: 4, unchanged: 3, errors: 1 });

        await expect(controller.updateAllUserTiers(mockReq as never)).resolves.toEqual(
            expect.objectContaining({
                message: "Updated 4 user tiers. 3 unchanged, 1 errors.",
                data: { updated: 4, unchanged: 3, errors: 1 },
            }),
        );

        expect(buildResponseMock).toHaveBeenCalledWith({
            message: "Updated 4 user tiers. 3 unchanged, 1 errors.",
            data: { updated: 4, unchanged: 3, errors: 1 },
        });
        expect(mockAuditLogService.log).toHaveBeenCalledWith(
            expect.objectContaining({ action: "UPDATE_ALL_USER_TIERS", resource: "user" }),
        );
    });
});