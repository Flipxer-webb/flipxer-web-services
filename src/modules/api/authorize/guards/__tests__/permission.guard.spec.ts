import { HttpStatus } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserType } from "@prisma/client";

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class { readonly __stub = true },
    UserNotFoundException: class extends Error {
        status: number;
        constructor(message: string, status: number) {
            super(message);
            this.status = status;
        }
    },
    __esModule: true,
}));

import { PermissionGuard } from "../permission.guard";
import { PrismaService } from "@/modules/core/prisma/services";
import { RoleEnum } from "../../enums/role";

function makeContext(user: any) {
    return {
        getHandler: jest.fn(),
        getClass: jest.fn(),
        switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as any;
}

function makePrisma() {
    return {
        role: { findUnique: jest.fn() },
        rolePermission: { findMany: jest.fn() },
        permission: { findMany: jest.fn() },
    };
}

describe("PermissionGuard", () => {
    let reflector: { getAllAndMerge: jest.Mock };
    let prisma: ReturnType<typeof makePrisma>;

    beforeEach(() => {
        reflector = { getAllAndMerge: jest.fn() };
        prisma = makePrisma();
    });

    it("should allow when no permissions are decorated", async () => {
        reflector.getAllAndMerge.mockReturnValue(undefined);
        const guard = new PermissionGuard(reflector as unknown as Reflector, prisma as unknown as PrismaService);

        await expect(guard.canActivate(makeContext({ id: 1 }))).resolves.toBe(true);
    });

    it("should throw when authenticated user is missing", async () => {
        reflector.getAllAndMerge.mockReturnValue(["read:users"]);
        const guard = new PermissionGuard(reflector as unknown as Reflector, prisma as unknown as PrismaService);

        await expect(guard.canActivate(makeContext(null))).rejects.toThrow();
    });

    it("should allow SUPER_ADMIN user type without permission lookup", async () => {
        reflector.getAllAndMerge.mockReturnValue(["read:users"]);
        const guard = new PermissionGuard(reflector as unknown as Reflector, prisma as unknown as PrismaService);

        await expect(
            guard.canActivate(makeContext({ id: 1, userType: UserType.SUPER_ADMIN }))
        ).resolves.toBe(true);
    });

    it("should throw when roleId is missing", async () => {
        reflector.getAllAndMerge.mockReturnValue(["read:users"]);
        const guard = new PermissionGuard(reflector as unknown as Reflector, prisma as unknown as PrismaService);

        await expect(
            guard.canActivate(makeContext({ id: 1, userType: UserType.INDIVIDUAL, roleId: null }))
        ).rejects.toThrow();
    });

    it("should throw when role is not found", async () => {
        reflector.getAllAndMerge.mockReturnValue(["read:users"]);
        prisma.role.findUnique.mockResolvedValue(null);
        const guard = new PermissionGuard(reflector as unknown as Reflector, prisma as unknown as PrismaService);

        await expect(
            guard.canActivate(makeContext({ id: 1, userType: UserType.INDIVIDUAL, roleId: 20 }))
        ).rejects.toThrow();
    });

    it("should allow when role slug is super admin", async () => {
        reflector.getAllAndMerge.mockReturnValue(["read:users"]);
        prisma.role.findUnique.mockResolvedValue({ id: 2, slug: RoleEnum.SUPER_ADMIN });
        const guard = new PermissionGuard(reflector as unknown as Reflector, prisma as unknown as PrismaService);

        await expect(
            guard.canActivate(makeContext({ id: 1, userType: UserType.INDIVIDUAL, roleId: 2 }))
        ).resolves.toBe(true);
    });

    it("should throw when required permission is missing", async () => {
        reflector.getAllAndMerge.mockReturnValue(["write:users"]);
        prisma.role.findUnique.mockResolvedValue({ id: 2, slug: "admin" });
        prisma.rolePermission.findMany.mockResolvedValue([{ permissionId: 1 }]);
        prisma.permission.findMany.mockResolvedValue([{ id: 1, name: "read:users" }]);
        const guard = new PermissionGuard(reflector as unknown as Reflector, prisma as unknown as PrismaService);

        await expect(
            guard.canActivate(makeContext({ id: 1, userType: UserType.INDIVIDUAL, roleId: 2 }))
        ).rejects.toThrow();
    });

    it("should allow when all required permissions exist", async () => {
        reflector.getAllAndMerge.mockReturnValue(["read:users", "write:users"]);
        prisma.role.findUnique.mockResolvedValue({ id: 2, slug: "admin" });
        prisma.rolePermission.findMany.mockResolvedValue([{ permissionId: 1 }, { permissionId: 2 }]);
        prisma.permission.findMany.mockResolvedValue([
            { id: 1, name: "read:users" },
            { id: 2, name: "write:users" },
        ]);
        const guard = new PermissionGuard(reflector as unknown as Reflector, prisma as unknown as PrismaService);

        await expect(
            guard.canActivate(makeContext({ id: 1, userType: UserType.INDIVIDUAL, roleId: 2 }))
        ).resolves.toBe(true);
    });
});