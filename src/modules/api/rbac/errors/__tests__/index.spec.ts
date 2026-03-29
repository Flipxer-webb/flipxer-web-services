import { HttpStatus } from "@nestjs/common";
import {
    AdminUserAlreadyExistsException,
    AdminUserNotFoundException,
    CannotDeleteDefaultRoleException,
    CannotModifySuperAdminException,
    PermissionNotFoundException,
    PrivilegeEscalationException,
    RoleAlreadyExistsException,
    RoleNotFoundException,
} from "../index";

describe("RBAC errors", () => {
    it("builds role-related exceptions", () => {
        const roleExists = new RoleAlreadyExistsException("Role exists");
        expect(roleExists.getStatus()).toBe(HttpStatus.CONFLICT);
        expect(roleExists.getResponse()).toEqual({ success: false, message: "Role exists" });

        const roleNotFound = new RoleNotFoundException();
        expect(roleNotFound.getStatus()).toBe(HttpStatus.NOT_FOUND);

        const permissionNotFound = new PermissionNotFoundException();
        expect(permissionNotFound.getStatus()).toBe(HttpStatus.NOT_FOUND);

        const cannotDelete = new CannotDeleteDefaultRoleException();
        expect(cannotDelete.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    });

    it("builds admin-related exceptions", () => {
        const adminExists = new AdminUserAlreadyExistsException("admin@example.com");
        expect(adminExists.getStatus()).toBe(HttpStatus.CONFLICT);
        expect(adminExists.getResponse()).toEqual({
            success: false,
            message: "Admin user with email admin@example.com already exists",
        });

        const adminNotFound = new AdminUserNotFoundException();
        expect(adminNotFound.getStatus()).toBe(HttpStatus.NOT_FOUND);

        const cannotModifySuperAdmin = new CannotModifySuperAdminException();
        expect(cannotModifySuperAdmin.getStatus()).toBe(HttpStatus.FORBIDDEN);

        const privilegeEscalation = new PrivilegeEscalationException();
        expect(privilegeEscalation.getStatus()).toBe(HttpStatus.FORBIDDEN);
    });
});
