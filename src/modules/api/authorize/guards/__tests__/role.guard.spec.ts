import { Reflector } from "@nestjs/core";

import { RoleGuard, SocketRoleGuard } from "../role.guard";

function makeHttpContext(user: any) {
    return {
        getHandler: jest.fn(),
        getClass: jest.fn(),
        switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as any;
}

function makeWsContext(user: any) {
    return {
        getHandler: jest.fn(),
        getClass: jest.fn(),
        switchToWs: () => ({ getClient: () => ({ data: { user } }) }),
    } as any;
}

describe("RoleGuard", () => {
    let reflector: { getAllAndOverride: jest.Mock };

    beforeEach(() => {
        reflector = { getAllAndOverride: jest.fn() };
    });

    it("should allow access when no roles are decorated", async () => {
        reflector.getAllAndOverride.mockReturnValue(undefined);
        const guard = new RoleGuard(reflector as unknown as Reflector);

        await expect(guard.canActivate(makeHttpContext({ userType: "USER" }))).resolves.toBe(true);
    });

    it("should allow access for matching role", async () => {
        reflector.getAllAndOverride.mockReturnValue(["ADMIN"]);
        const guard = new RoleGuard(reflector as unknown as Reflector);

        await expect(guard.canActivate(makeHttpContext({ userType: "ADMIN" }))).resolves.toBe(true);
    });

    it("should deny access for non-matching role", async () => {
        reflector.getAllAndOverride.mockReturnValue(["ADMIN"]);
        const guard = new RoleGuard(reflector as unknown as Reflector);

        await expect(guard.canActivate(makeHttpContext({ userType: "USER" }))).rejects.toThrow();
    });
});

describe("SocketRoleGuard", () => {
    let reflector: { getAllAndOverride: jest.Mock };

    beforeEach(() => {
        reflector = { getAllAndOverride: jest.fn() };
    });

    it("should allow websocket access when no roles are decorated", () => {
        reflector.getAllAndOverride.mockReturnValue(undefined);
        const guard = new SocketRoleGuard(reflector as unknown as Reflector);

        expect(guard.canActivate(makeWsContext({ userType: "ADMIN" }))).toBe(true);
    });

    it("should allow websocket access for matching role", () => {
        reflector.getAllAndOverride.mockReturnValue(["ADMIN"]);
        const guard = new SocketRoleGuard(reflector as unknown as Reflector);

        expect(guard.canActivate(makeWsContext({ userType: "ADMIN" }))).toBe(true);
    });

    it("should deny websocket access when user is missing", () => {
        reflector.getAllAndOverride.mockReturnValue(["ADMIN"]);
        const guard = new SocketRoleGuard(reflector as unknown as Reflector);

        expect(() => guard.canActivate(makeWsContext(null))).toThrow();
    });
});