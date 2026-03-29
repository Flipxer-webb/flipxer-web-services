import { HttpStatus } from "@nestjs/common";
import { MaintenanceMiddleware } from "../maintenance.middleware";
import * as middlewareIndex from "../index";

describe("System config middleware", () => {
    it("re-exports MaintenanceMiddleware", () => {
        expect(middlewareIndex.MaintenanceMiddleware).toBe(MaintenanceMiddleware);
    });

    it("bypasses maintenance when shouldBypass is true", async () => {
        const maintenanceService = {
            shouldBypass: jest.fn().mockResolvedValue(true),
            getMaintenanceConfig: jest.fn(),
        };

        const middleware = new MaintenanceMiddleware(maintenanceService as any);
        const req = { ip: "127.0.0.1", user: { userType: "ADMIN" }, headers: {} } as any;
        const res = { status: jest.fn(), json: jest.fn() } as any;
        const next = jest.fn();

        await middleware.use(req, res, next);

        expect(maintenanceService.shouldBypass).toHaveBeenCalledWith("127.0.0.1", true);
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
    });

    it("returns service unavailable response when maintenance is active", async () => {
        const maintenanceService = {
            shouldBypass: jest.fn().mockResolvedValue(false),
            getMaintenanceConfig: jest.fn().mockResolvedValue({
                message: "Planned maintenance",
                estimatedEndTime: "2026-03-30T00:00:00Z",
            }),
        };

        const middleware = new MaintenanceMiddleware(maintenanceService as any);
        const req = { ip: "127.0.0.1", user: { userType: "USER" }, headers: {} } as any;
        const res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
        } as any;

        await middleware.use(req, res, jest.fn());

        expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                statusCode: HttpStatus.SERVICE_UNAVAILABLE,
                maintenance: expect.objectContaining({ enabled: true, message: "Planned maintenance" }),
            })
        );
    });
});
