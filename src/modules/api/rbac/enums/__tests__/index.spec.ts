import {
    PermissionAction,
    PermissionGroup,
    PermissionNames,
    RoleTemplates,
} from "../index";

describe("rbac enums and templates", () => {
    it("exposes stable enum values", () => {
        expect(PermissionGroup.USERS).toBe("USERS");
        expect(PermissionGroup.SYSTEM).toBe("SYSTEM");
        expect(PermissionAction.CREATE).toBe("create");
        expect(PermissionAction.MANAGE).toBe("manage");
    });

    it("defines expected permission name constants", () => {
        expect(PermissionNames.USERS_READ).toBe("users.read");
        expect(PermissionNames.TRANSACTIONS_EXPORT).toBe("transactions.export");
        expect(PermissionNames.SYSTEM_AUDIT_LOGS).toBe("system.audit_logs");
    });

    it("keeps role templates mapped to valid permissions", () => {
        const allPermissionNames = Object.values(PermissionNames);

        expect(RoleTemplates.SUPER_ADMIN.permissions).toEqual(allPermissionNames);

        for (const template of Object.values(RoleTemplates)) {
            expect(template.name.length).toBeGreaterThan(0);
            expect(template.slug.length).toBeGreaterThan(0);
            expect(template.permissions.length).toBeGreaterThan(0);
            expect(template.permissions.every((p) => allPermissionNames.includes(p))).toBe(true);
        }
    });
});
