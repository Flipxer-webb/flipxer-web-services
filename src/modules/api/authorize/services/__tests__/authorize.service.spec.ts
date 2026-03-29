import { GUARDS_METADATA } from "@nestjs/common/constants";
import { ADMIN_USER_TYPES, UserTypes } from "../../decorator";
import AuthorizationService from "../authorize.service";

jest.mock("@/modules/api/auth/guard", () => ({
    AuthGuard: class AuthGuard {
        canActivate() {
            return true;
        }
    },
}));

jest.mock("@/modules/api/authorize/guards/role.guard", () => ({
    RoleGuard: class RoleGuard {
        canActivate() {
            return true;
        }
    },
}));

describe("AuthorizationService", () => {
    it("defines class guards and allowed user types", () => {
        const guards = Reflect.getMetadata(GUARDS_METADATA, AuthorizationService) as unknown[];
        const userTypes = Reflect.getMetadata(UserTypes.KEY, AuthorizationService);

        expect(Array.isArray(guards)).toBe(true);
        expect(guards).toHaveLength(2);
        expect(userTypes).toEqual(ADMIN_USER_TYPES);
    });

    it("constructs with prisma service dependency", () => {
        const prisma = { marker: true } as any;
        const service = new AuthorizationService(prisma);

        expect(service).toBeInstanceOf(AuthorizationService);
    });
});
