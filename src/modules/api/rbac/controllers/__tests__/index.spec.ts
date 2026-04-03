import { RbacController } from "../index";
import { RbacSeedController } from "../seed.controller";

const TEST_ADMIN_SECRET = "x";

describe("RbacController", () => {
    let controller: RbacController;
    let seedController: RbacSeedController;
    let rbacService: {
        getAllRoles: jest.Mock;
        getRoleById: jest.Mock;
        createRole: jest.Mock;
        updateRole: jest.Mock;
        deleteRole: jest.Mock;
        assignPermissionsToRole: jest.Mock;
        getAllPermissions: jest.Mock;
        getAdminUsers: jest.Mock;
        getAdminUserById: jest.Mock;
        createAdminUser: jest.Mock;
        updateAdminUser: jest.Mock;
        deleteAdminUser: jest.Mock;
        changeAdminPassword: jest.Mock;
        getAuditLogs: jest.Mock;
        seedPermissions: jest.Mock;
    };

    const req = {
        ip: "127.0.0.1",
        headers: { "user-agent": "jest" },
        user: { id: 900 },
    };

    beforeEach(() => {
        rbacService = {
            getAllRoles: jest.fn(),
            getRoleById: jest.fn(),
            createRole: jest.fn(),
            updateRole: jest.fn(),
            deleteRole: jest.fn(),
            assignPermissionsToRole: jest.fn(),
            getAllPermissions: jest.fn(),
            getAdminUsers: jest.fn(),
            getAdminUserById: jest.fn(),
            createAdminUser: jest.fn(),
            updateAdminUser: jest.fn(),
            deleteAdminUser: jest.fn(),
            changeAdminPassword: jest.fn(),
            getAuditLogs: jest.fn(),
            seedPermissions: jest.fn(),
        };

        controller = new RbacController(rbacService as never);
        seedController = new RbacSeedController(rbacService as never);
    });

    it("delegates role and permission endpoints", async () => {
        rbacService.getAllRoles.mockResolvedValue([{ id: 1 }]);
        rbacService.getRoleById.mockResolvedValue({ id: 2 });
        rbacService.createRole.mockResolvedValue({ id: 3 });
        rbacService.updateRole.mockResolvedValue({ id: 4 });
        rbacService.deleteRole.mockResolvedValue({ deleted: true });
        rbacService.assignPermissionsToRole.mockResolvedValue({ ok: true });
        rbacService.getAllPermissions.mockResolvedValue([{ id: 7 }]);

        await expect(controller.getAllRoles()).resolves.toEqual([{ id: 1 }]);
        await expect(controller.getRoleById(2)).resolves.toEqual({ id: 2 });
        await expect(controller.createRole({ name: "ops" } as never, req as never)).resolves.toEqual({ id: 3 });
        await expect(controller.updateRole(4, { name: "ops-2" } as never, req as never)).resolves.toEqual({ id: 4 });
        await expect(controller.deleteRole(4, req as never)).resolves.toEqual({ deleted: true });
        await expect(controller.assignPermissions(5, { permissionIds: [1, 2] } as never, req as never)).resolves.toEqual({ ok: true });
        await expect(controller.getAllPermissions()).resolves.toEqual([{ id: 7 }]);

        expect(rbacService.createRole).toHaveBeenCalledWith(
            { name: "ops" },
            expect.objectContaining({ adminId: 900, ipAddress: "127.0.0.1" }),
        );
        expect(rbacService.updateRole).toHaveBeenCalledWith(
            4,
            { name: "ops-2" },
            expect.objectContaining({ adminId: 900, userAgent: "jest" }),
        );
        expect(rbacService.deleteRole).toHaveBeenCalledWith(
            4,
            expect.objectContaining({ adminId: 900 }),
        );
    });

    it("delegates admin user and audit endpoints", async () => {
        rbacService.getAdminUsers.mockResolvedValue({ rows: [] });
        rbacService.getAdminUserById.mockResolvedValue({ id: 5 });
        rbacService.createAdminUser.mockResolvedValue({ id: 6 });
        rbacService.updateAdminUser.mockResolvedValue({ id: 7 });
        rbacService.deleteAdminUser.mockResolvedValue({ deleted: true });
        rbacService.changeAdminPassword.mockResolvedValue({ ok: true });
        rbacService.getAuditLogs.mockResolvedValue({ total: 2 });

        await expect(controller.getAdminUsers({ page: 1 } as never)).resolves.toEqual({ rows: [] });
        await expect(controller.getAdminUserById(5)).resolves.toEqual({ id: 5 });
        await expect(controller.createAdminUser({ email: "a@b.com" } as never, req as never)).resolves.toEqual({ id: 6 });
        await expect(controller.updateAdminUser(7, { firstName: "Jane" } as never, req as never)).resolves.toEqual({ id: 7 });
        await expect(controller.deleteAdminUser(7, req as never)).resolves.toEqual({ deleted: true });
        await expect(controller.changeAdminPassword(7, { password: TEST_ADMIN_SECRET } as never, req as never)).resolves.toEqual({ ok: true });
        await expect(controller.getAuditLogs({ page: 1 } as never)).resolves.toEqual({ total: 2 });

        expect(rbacService.createAdminUser).toHaveBeenCalledWith(
            { email: "a@b.com" },
            expect.objectContaining({ adminId: 900 }),
        );
        expect(rbacService.updateAdminUser).toHaveBeenCalledWith(
            7,
            { firstName: "Jane" },
            expect.objectContaining({ ipAddress: "127.0.0.1" }),
        );
        expect(rbacService.changeAdminPassword).toHaveBeenCalledWith(
            7,
            { password: TEST_ADMIN_SECRET },
            expect.objectContaining({ userAgent: "jest" }),
        );
    });

    it("seed controller should seed then return permissions", async () => {
        rbacService.seedPermissions.mockResolvedValue(undefined);
        rbacService.getAllPermissions.mockResolvedValue([{ key: "roles.read" }]);

        await expect(seedController.seedPermissions()).resolves.toEqual([{ key: "roles.read" }]);
        expect(rbacService.seedPermissions).toHaveBeenCalledTimes(1);
        expect(rbacService.getAllPermissions).toHaveBeenCalledTimes(1);
    });
});
