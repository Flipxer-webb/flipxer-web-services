jest.mock("@/modules/api/auth/guard", () => ({
    AuthGuard: class { readonly stub = true; },
    EnabledAccountGuard: class { readonly stub = true; },
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/guards/role.guard", () => ({
    RoleGuard: class { readonly stub = true; },
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/guards/permission.guard", () => ({
    PermissionGuard: class { readonly stub = true; },
    __esModule: true,
}));

describe("reports controller barrel exports", () => {
    it("exports admin reports controller through nested barrels", async () => {
        const controllers = await import("../index");
        const v1Controllers = await import("../v1");
        const adminControllers = await import("../v1/admin");

        expect(controllers.AdminReportsController).toBeDefined();
        expect(v1Controllers.AdminReportsController).toBeDefined();
        expect(adminControllers.AdminReportsController).toBeDefined();
    });
});