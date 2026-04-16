import { RbacService } from "../index";
import { UserType } from "@prisma/client";
import {
    AdminInviteAlreadyUsedException,
    AdminInviteNotFoundException,
    AdminUserAlreadyExistsException,
    AdminUserNotFoundException,
    CannotDeleteDefaultRoleException,
    CannotModifySuperAdminException,
    PermissionNotFoundException,
    PrivilegeEscalationException,
    RoleAlreadyExistsException,
    RoleNotFoundException,
} from "../../errors";

jest.mock("@/config", () => ({
    COMPANY_NAME: "Flipxer",
    frontendUrl: "https://resolve-web-app-cyan.vercel.app",
    mailConfig: { senderMail: "hello@flipxer.com" },
    emailTemplateConfig: { admin_invite: "tpl-admin-invite" },
}));

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
        adminInvite: {
            deleteMany: jest.fn(),
            create: jest.fn(),
            delete: jest.fn(),
            findUnique: jest.fn(),
            update: jest.fn(),
        },
        $transaction: jest.fn(),
    };
}

describe("RbacService", () => {
    let prisma: ReturnType<typeof makePrisma>;
    let service: RbacService;
    let emailService: { sendMailWithTemplate: jest.Mock };
    const mockAuditLogService = { log: jest.fn().mockResolvedValue(undefined) };
    const generatedAdminPassword = `test-${Date.now()}`;

    beforeEach(() => {
        prisma = makePrisma();
        emailService = {
            sendMailWithTemplate: jest.fn().mockResolvedValue({ request_id: "req-id" }),
        };
        service = new RbacService(prisma as any, emailService as any, mockAuditLogService as any);
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

    it("returns detailed role data from getRoleById", async () => {
        prisma.role.findUnique.mockResolvedValue({
            id: 3,
            name: "Risk Admin",
            slug: "risk-admin",
            description: "Risk operations",
            isAdmin: true,
            createdAt: new Date("2026-02-02"),
            _count: { users: 2 },
            rolePermission: [
                {
                    permission: {
                        id: 9,
                        name: "risk.read",
                        description: "Read risk data",
                        group: "RISK",
                    },
                },
            ],
        });

        const result = await service.getRoleById(3);

        expect(result.success).toBe(true);
        expect(result.data.usersCount).toBe(2);
        expect(result.data.permissions[0].group).toBe("RISK");
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
        expect(mockAuditLogService.log).toHaveBeenCalled();
    });

    it("blocks updateRole for super-admin", async () => {
        prisma.role.findUnique.mockResolvedValue({ id: 1, slug: "super-admin" });

        await expect(service.updateRole(1, { name: "new" } as any)).rejects.toBeInstanceOf(
            CannotModifySuperAdminException
        );
    });

    it("updates role metadata and permissions", async () => {
        prisma.role.findUnique.mockResolvedValue({ id: 8, slug: "ops-admin" });
        prisma.role.update.mockResolvedValue({
            id: 8,
            name: "Ops Lead",
            slug: "ops-lead",
            rolePermission: [{ permission: { id: 3, name: "users.write" } }],
        });

        const result = await service.updateRole(
            8,
            {
                name: "Ops Lead",
                description: "Lead operations",
                permissionIds: [3],
            } as any,
            { adminId: 42 }
        );

        expect(result.success).toBe(true);
        expect(prisma.rolePermission.deleteMany).toHaveBeenCalledWith({ where: { roleId: 8 } });
        expect(prisma.rolePermission.createMany).toHaveBeenCalledWith({
            data: [{ roleId: 8, permissionId: 3 }],
        });
    });

    it("throws RoleNotFoundException when updating unknown role", async () => {
        prisma.role.findUnique.mockResolvedValue(null);

        await expect(service.updateRole(101, { description: "none" } as any)).rejects.toBeInstanceOf(
            RoleNotFoundException
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

    it("deletes non-default role and writes audit log", async () => {
        prisma.role.findUnique.mockResolvedValue({
            id: 21,
            slug: "finance-admin",
            name: "Finance",
            _count: { users: 0 },
        });

        const result = await service.deleteRole(21, { adminId: 77 });

        expect(result.success).toBe(true);
        expect(prisma.rolePermission.deleteMany).toHaveBeenCalledWith({ where: { roleId: 21 } });
        expect(prisma.role.delete).toHaveBeenCalledWith({ where: { id: 21 } });
    });

    it("throws RoleNotFoundException when assigning permissions to unknown role", async () => {
        prisma.role.findUnique.mockResolvedValue(null);

        await expect(
            service.assignPermissionsToRole(44, { permissionIds: [1, 2] } as any)
        ).rejects.toBeInstanceOf(RoleNotFoundException);
    });

    it("throws PermissionNotFoundException when assigning invalid permissions", async () => {
        prisma.role.findUnique.mockResolvedValue({ id: 44 });
        prisma.permission.findMany.mockResolvedValue([{ id: 1 }]);

        await expect(
            service.assignPermissionsToRole(44, { permissionIds: [1, 2] } as any)
        ).rejects.toBeInstanceOf(PermissionNotFoundException);
    });

    it("assigns permissions successfully", async () => {
        prisma.role.findUnique.mockResolvedValue({ id: 11 });
        prisma.permission.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);

        const result = await service.assignPermissionsToRole(
            11,
            { permissionIds: [1, 2] } as any,
            { adminId: 18 }
        );

        expect(result.success).toBe(true);
        expect(prisma.rolePermission.deleteMany).toHaveBeenCalledWith({ where: { roleId: 11 } });
        expect(prisma.rolePermission.createMany).toHaveBeenCalledWith({
            data: [
                { roleId: 11, permissionId: 1 },
                { roleId: 11, permissionId: 2 },
            ],
        });
    });

    it("groups permissions by group", async () => {
        prisma.permission.findMany.mockResolvedValue([
            { id: 1, name: "users.read", group: "USERS" },
            { id: 2, name: "users.write", group: "USERS" },
            { id: 3, name: "orders.read", group: "ORDERS" },
        ]);

        const result = await service.getAllPermissions();

        expect(result.success).toBe(true);
        expect(result.data.grouped.USERS).toHaveLength(2);
        expect(result.data.grouped.ORDERS).toHaveLength(1);
    });

    it("throws AdminUserAlreadyExistsException when creating admin with duplicate email", async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 1 });

        await expect(
            service.createAdminUser(
                {
                    firstName: "Existing",
                    lastName: "Admin",
                    email: "existing@example.com",
                    phone: "08022222222",
                    password: generatedAdminPassword,
                    roleId: 2,
                } as any
            )
        ).rejects.toBeInstanceOf(AdminUserAlreadyExistsException);
    });

    it("throws RoleNotFoundException when creating admin with non-admin role", async () => {
        prisma.user.findUnique.mockResolvedValue(null);
        prisma.role.findUnique.mockResolvedValue({ id: 99, isAdmin: false });

        await expect(
            service.createAdminUser(
                {
                    firstName: "Not",
                    lastName: "Allowed",
                    email: "not-allowed@example.com",
                    phone: "08033333333",
                    password: generatedAdminPassword,
                    roleId: 99,
                } as any
            )
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
                    password: generatedAdminPassword,
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
            password: generatedAdminPassword,
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

    it("sends admin invite email and stores pending invite", async () => {
        prisma.user.findUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ firstName: "Inviter", lastName: "Admin", email: "inviter@flipxer.com" });
        prisma.role.findUnique.mockResolvedValue({ id: 12, isAdmin: true, slug: "ops-admin", name: "Ops" });
        prisma.adminInvite.create.mockResolvedValue({
            id: 900,
            email: "new-admin@flipxer.com",
            expiresAt: new Date("2026-04-07T00:00:00.000Z"),
        });

        const result = await service.inviteAdminUser(
            {
                firstName: "New",
                lastName: "Admin",
                email: "new-admin@flipxer.com",
                roleId: 12,
            } as any,
            { adminId: 4, ipAddress: "127.0.0.1", userAgent: "jest" },
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain("invite sent");
        expect(prisma.adminInvite.deleteMany).toHaveBeenCalledWith({
            where: { email: "new-admin@flipxer.com", acceptedAt: null },
        });
        expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
            expect.objectContaining({
                template_key: "tpl-admin-invite",
                to: [{ email_address: { address: "new-admin@flipxer.com" } }],
            }),
        );
    });

    it("resends admin invite with rotated token", async () => {
        prisma.adminInvite.findUnique.mockResolvedValue({
            id: 11,
            token: "old-token",
            email: "pending-admin@flipxer.com",
            firstName: "Pending",
            acceptedAt: null,
            expiresAt: new Date("2026-04-06T00:00:00.000Z"),
            role: { name: "Ops", slug: "ops-admin", isAdmin: true },
        });
        prisma.user.findUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ firstName: "Inviter", lastName: "Admin", email: "inviter@flipxer.com" });
        prisma.adminInvite.update.mockResolvedValue({
            id: 11,
            email: "pending-admin@flipxer.com",
            expiresAt: new Date(),
        });

        const result = await service.resendAdminInvite(11, { adminId: 7 });

        expect(result.success).toBe(true);
        expect(result.message).toContain("resent");
        expect(prisma.adminInvite.update).toHaveBeenCalled();
        expect(emailService.sendMailWithTemplate).toHaveBeenCalled();
    });

    it("throws AdminInviteNotFoundException when resending unknown invite", async () => {
        prisma.adminInvite.findUnique.mockResolvedValue(null);

        await expect(service.resendAdminInvite(404, { adminId: 7 })).rejects.toBeInstanceOf(
            AdminInviteNotFoundException,
        );
    });

    it("throws AdminInviteAlreadyUsedException when resending used invite", async () => {
        prisma.adminInvite.findUnique.mockResolvedValue({
            id: 77,
            acceptedAt: new Date(),
            role: { name: "Ops", slug: "ops-admin", isAdmin: true },
        });

        await expect(service.resendAdminInvite(77, { adminId: 7 })).rejects.toBeInstanceOf(
            AdminInviteAlreadyUsedException,
        );
    });

    it("revokes pending admin invite", async () => {
        prisma.adminInvite.findUnique.mockResolvedValue({
            id: 32,
            email: "revoke-admin@flipxer.com",
            acceptedAt: null,
            role: { name: "Ops" },
        });

        const result = await service.revokeAdminInvite(32, { adminId: 12 });

        expect(result.success).toBe(true);
        expect(prisma.adminInvite.delete).toHaveBeenCalledWith({ where: { id: 32 } });
    });

    it("returns admin with flattened permissions", async () => {
        prisma.user.findFirst.mockResolvedValue({
            id: 33,
            email: "admin@get.example",
            role: {
                rolePermission: [{ permission: { id: 1, name: "users.read" } }],
            },
        });

        const result = await service.getAdminUserById(33);

        expect(result.success).toBe(true);
        expect(result.data.permissions).toEqual([{ id: 1, name: "users.read" }]);
    });

    it("throws AdminUserNotFoundException for unknown admin id", async () => {
        prisma.user.findFirst.mockResolvedValue(null);

        await expect(service.getAdminUserById(9999)).rejects.toBeInstanceOf(AdminUserNotFoundException);
    });

    it("updates admin user role/status and syncs user type", async () => {
        prisma.user.findFirst.mockResolvedValue({ id: 50, role: { slug: "ops-admin" } });
        prisma.role.findUnique.mockResolvedValue({ id: 5, isAdmin: true, slug: "super-admin" });
        prisma.user.update.mockResolvedValue({ id: 50, email: "user@example.com", role: { name: "Super" } });

        const result = await service.updateAdminUser(
            50,
            { firstName: "Neo", lastName: "Admin", phone: "08044444444", roleId: 5, isActive: false } as any,
            { adminId: 2 }
        );

        expect(result.success).toBe(true);
        expect(prisma.user.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    firstName: "Neo",
                    lastName: "Admin",
                    phone: "08044444444",
                    status: "BLOCKED",
                    userType: UserType.SUPER_ADMIN,
                }),
            })
        );
    });

    it("throws AdminUserNotFoundException when updating unknown admin", async () => {
        prisma.user.findFirst.mockResolvedValue(null);

        await expect(service.updateAdminUser(88, { firstName: "x" } as any)).rejects.toBeInstanceOf(
            AdminUserNotFoundException
        );
    });

    it("throws CannotModifySuperAdminException when updating super admin", async () => {
        prisma.user.findFirst.mockResolvedValue({ id: 1, role: { slug: "super-admin" } });

        await expect(service.updateAdminUser(1, { firstName: "x" } as any)).rejects.toBeInstanceOf(
            CannotModifySuperAdminException
        );
    });

    it("throws RoleNotFoundException when updating admin with non-admin role", async () => {
        prisma.user.findFirst.mockResolvedValue({ id: 90, role: { slug: "ops-admin" } });
        prisma.role.findUnique.mockResolvedValue({ id: 300, isAdmin: false });

        await expect(service.updateAdminUser(90, { roleId: 300 } as any)).rejects.toBeInstanceOf(RoleNotFoundException);
    });

    it("deactivates admin user", async () => {
        prisma.user.findFirst.mockResolvedValue({ id: 60, email: "admin@x.com", role: { slug: "ops-admin" } });

        const result = await service.deleteAdminUser(60, { adminId: 9 });

        expect(result.success).toBe(true);
        expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 60 }, data: { status: "BLOCKED" } });
    });

    it("throws AdminUserNotFoundException when deleting unknown admin", async () => {
        prisma.user.findFirst.mockResolvedValue(null);

        await expect(service.deleteAdminUser(404)).rejects.toBeInstanceOf(AdminUserNotFoundException);
    });

    it("throws CannotModifySuperAdminException when deleting super admin", async () => {
        prisma.user.findFirst.mockResolvedValue({ id: 1, email: "root@example.com", role: { slug: "super-admin" } });

        await expect(service.deleteAdminUser(1)).rejects.toBeInstanceOf(CannotModifySuperAdminException);
    });

    it("changes admin password successfully", async () => {
        prisma.user.findFirst.mockResolvedValue({ id: 71 });

        const result = await service.changeAdminPassword(
            71,
            { newPassword: generatedAdminPassword } as any,
            { adminId: 7 }
        );

        expect(result.success).toBe(true);
        expect(prisma.user.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 71 },
                data: { password: expect.any(String) },
            })
        );
    });

    it("throws AdminUserNotFoundException when changing password for unknown admin", async () => {
        prisma.user.findFirst.mockResolvedValue(null);

        await expect(
            service.changeAdminPassword(919, { newPassword: generatedAdminPassword } as any)
        ).rejects.toBeInstanceOf(AdminUserNotFoundException);
    });

    it("propagates error when audit log write fails", async () => {
        prisma.role.findFirst.mockResolvedValue(null);
        prisma.permission.findMany.mockResolvedValue([{ id: 1 }]);
        prisma.role.create.mockResolvedValue({
            id: 99,
            name: "Recovery Admin",
            slug: "recovery-admin",
            description: "Recovery",
            rolePermission: [{ permission: { id: 1, name: "audit.read" } }],
        });
        mockAuditLogService.log.mockRejectedValueOnce(new Error("audit down"));

        await expect(
            service.createRole({
                name: "Recovery Admin",
                description: "Recovery",
                permissionIds: [1],
            } as any)
        ).rejects.toThrow("audit down");
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
