import { RbacService } from "../index";
import { UserType } from "@prisma/client";
import {
    CannotDeleteDefaultRoleException,
    CannotModifySuperAdminException,
    PermissionNotFoundException,
    PrivilegeEscalationException,
    RoleAlreadyExistsException,
    RoleNotFoundException,
} from "../../errors";

jest.mock("bcryptjs", () => ({
    hash: jest.fn().mockResolvedValue("hashed-password"),
}));

jest.mock("@/utils", () => ({
    buildPaginationMeta: jest.fn((pageNumber: number, pageSize: number, total: number, returned: number) => ({
        pageNumber,
        pageSize,
        total,
        returned,
    })),
    generateId: jest.fn(() => "ID-123"),
}));

function makePrisma() {
    return {
        role: {
            findMany: jest.fn(),
            findUnique: jest.fn(),
            findFirst: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
        },
        rolePermission: {
            deleteMany: jest.fn(),
            createMany: jest.fn(),
        },
        permission: {
            findMany: jest.fn(),
            upsert: jest.fn(),
        },
        user: {
            findMany: jest.fn(),
            findFirst: jest.fn(),
            findUnique: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            count: jest.fn(),
        },
        auditLog: {
            create: jest.fn().mockResolvedValue({ id: 1 }),
            findMany: jest.fn(),
            count: jest.fn(),
        },
        $transaction: jest.fn(),
    };
}

describe("RbacService", () => {
    let prisma: ReturnType<typeof makePrisma>;
    let service: RbacService;
    const generatedAdminSecret = `test-${Date.now()}`;

    beforeEach(() => {
        prisma = makePrisma();
        service = new RbacService(prisma as any);
    });

    it("returns shaped roles from getAllRoles", async () => {
        prisma.role.findMany.mockResolvedValue([
            {
                id: 7,
                name: "Ops Admin",
                slug: "ops-admin",
                description: "Operations",
                isAdmin: true,
                createdAt: new Date("2026-01-01"),
                _count: { users: 4 },
                rolePermission: [
                    {
                        permission: {
                            id: 2,
                            name: "users.read",
                            description: "Read users",
                            group: "USERS",
                        },
                    },
                ],
            },
        ]);

        const result = await service.getAllRoles();

        expect(result.success).toBe(true);
        expect(result.message).toContain("Roles retrieved");
        expect(result.data[0].usersCount).toBe(4);
        expect(result.data[0].permissions[0].name).toBe("users.read");
    });

    it("throws RoleNotFoundException for unknown role id", async () => {
        prisma.role.findUnique.mockResolvedValue(null);

        await expect(service.getRoleById(999)).rejects.toBeInstanceOf(RoleNotFoundException);
    });

    it("throws RoleAlreadyExistsException when creating duplicate role", async () => {
        prisma.role.findFirst.mockResolvedValue({ id: 1 });

        await expect(
            service.createRole({
                name: "Ops Admin",
                description: "desc",
                permissionIds: [1],
            } as any)
        ).rejects.toBeInstanceOf(RoleAlreadyExistsException);
    });

    it("throws PermissionNotFoundException when permissions are missing", async () => {
        prisma.role.findFirst.mockResolvedValue(null);
        prisma.permission.findMany.mockResolvedValue([{ id: 1 }]);

        await expect(
            service.createRole({
                name: "Support Admin",
                description: "desc",
                permissionIds: [1, 2],
            } as any)
        ).rejects.toBeInstanceOf(PermissionNotFoundException);
    });

    it("creates role and writes audit log", async () => {
        prisma.role.findFirst.mockResolvedValue(null);
        prisma.permission.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
        prisma.role.create.mockResolvedValue({
            id: 5,
            name: "Fraud Admin",
            slug: "fraud-admin",
            description: "Fraud ops",
            rolePermission: [
                { permission: { id: 1, name: "orders.read" } },
                { permission: { id: 2, name: "orders.write" } },
            ],
        });

        const result = await service.createRole(
            {
                name: "Fraud Admin",
                description: "Fraud ops",
                permissionIds: [1, 2],
            } as any,
            { adminId: 88, ipAddress: "127.0.0.1", userAgent: "jest" }
        );

        expect(result.success).toBe(true);
        expect(result.data.slug).toBe("fraud-admin");
        expect(prisma.auditLog.create).toHaveBeenCalled();
    });

    it("blocks updateRole for super-admin", async () => {
        prisma.role.findUnique.mockResolvedValue({ id: 1, slug: "super-admin" });

        await expect(service.updateRole(1, { name: "new" } as any)).rejects.toBeInstanceOf(
            CannotModifySuperAdminException
        );
    });

    it("returns non-destructive response when deleting role with assigned users", async () => {
        prisma.role.findUnique.mockResolvedValue({
            id: 17,
            slug: "ops-admin",
            name: "Ops",
            _count: { users: 3 },
        });

        const result = await service.deleteRole(17);

        expect(result.success).toBe(true);
        expect(result.message).toContain("Cannot delete role");
        expect(prisma.role.delete).not.toHaveBeenCalled();
    });

    it("throws CannotDeleteDefaultRoleException for protected roles", async () => {
        prisma.role.findUnique.mockResolvedValue({
            id: 1,
            slug: "super-admin",
            name: "Super",
            _count: { users: 0 },
        });

        await expect(service.deleteRole(1)).rejects.toBeInstanceOf(CannotDeleteDefaultRoleException);
    });

    it("throws RoleNotFoundException when assigning permissions to unknown role", async () => {
        prisma.role.findUnique.mockResolvedValue(null);

        await expect(
            service.assignPermissionsToRole(44, { permissionIds: [1, 2] } as any)
        ).rejects.toBeInstanceOf(RoleNotFoundException);
    });

    it("prevents non-super-admin from assigning super-admin role", async () => {
        prisma.user.findUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ userType: UserType.ADMIN });
        prisma.role.findUnique.mockResolvedValue({ id: 10, isAdmin: true, slug: "super-admin" });

        await expect(
            service.createAdminUser(
                {
                    firstName: "Ada",
                    lastName: "Lovelace",
                    email: "ada@example.com",
                    phone: "08000000000",
                    password: generatedAdminSecret,
                    roleId: 10,
                } as any,
                { adminId: 9 }
            )
        ).rejects.toBeInstanceOf(PrivilegeEscalationException);
    });

    it("creates admin user and syncs user type from non-super role", async () => {
        prisma.user.findUnique.mockResolvedValue(null);
        prisma.role.findUnique.mockResolvedValue({ id: 12, isAdmin: true, slug: "ops-admin", name: "Ops" });
        prisma.user.create.mockResolvedValue({
            id: 222,
            identifier: "ID-123",
            firstName: "Ken",
            lastName: "Stone",
            email: "ken@example.com",
            role: { name: "Ops" },
            createdAt: new Date(),
        });

        const result = await service.createAdminUser({
            firstName: "Ken",
            lastName: "Stone",
            email: "ken@example.com",
            phone: "08011111111",
            password: generatedAdminSecret,
            roleId: 12,
        } as any);

        expect(result.success).toBe(true);
        expect(prisma.user.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    userType: UserType.ADMIN,
                }),
            })
        );
    });

    it("returns paginated admin users", async () => {
        const admins = [{ id: 1, email: "admin@example.com" }];
        prisma.$transaction.mockResolvedValue([admins, 1]);

        const result = await service.getAdminUsers({ pageNumber: 1, pageSize: 20 } as any);

        expect(result.success).toBe(true);
        expect(result.data.records).toEqual(admins);
        expect(result.data.meta.total).toBe(1);
    });

    it("returns paginated audit logs", async () => {
        const logs = [{ id: 10, action: "CREATE_ROLE" }];
        prisma.$transaction.mockResolvedValue([logs, 1]);

        const result = await service.getAuditLogs({ pageNumber: 1, pageSize: 20 } as any);

        expect(result.success).toBe(true);
        expect(result.data.records).toEqual(logs);
    });

    it("seeds permissions through upsert", async () => {
        prisma.permission.upsert.mockResolvedValue({ id: 1 });

        await service.seedPermissions();

        expect(prisma.permission.upsert).toHaveBeenCalled();
    });
});
