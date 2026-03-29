import { GUARDS_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { ADMIN_USER_TYPES, UserTypes } from "../../../decorator";
import AuthorizationController from "../index";
import AuthorizationService from "../../../services/authorize.service";

jest.mock("@/modules/api/auth/guard", () => ({
    AuthGuard: class AuthGuard {
        canActivate() {
            return true;
        }
    },
}));

jest.mock("../../../guards/role.guard", () => ({
    RoleGuard: class RoleGuard {
        canActivate() {
            return true;
        }
    },
}));

jest.mock("../../../services/authorize.service", () => ({
    __esModule: true,
    default: class AuthorizationServiceMock {},
}));

describe("AuthorizationController", () => {
    it("defines route metadata, guards, and allowed user types", () => {
        const pathMeta = Reflect.getMetadata(PATH_METADATA, AuthorizationController);
        const guards = Reflect.getMetadata(GUARDS_METADATA, AuthorizationController) as unknown[];
        const userTypes = Reflect.getMetadata(UserTypes.KEY, AuthorizationController);

        expect(pathMeta).toBe("authz");
        expect(Array.isArray(guards)).toBe(true);
        expect(guards).toHaveLength(2);
        expect(userTypes).toEqual(ADMIN_USER_TYPES);
    });

    it("constructs with authorization service", () => {
        const service = { marker: true } as unknown as AuthorizationService;
        const controller = new AuthorizationController(service);

        expect(controller).toBeInstanceOf(AuthorizationController);
    });
});
