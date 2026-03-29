import { MaintenanceModeService } from "../maintenance-mode.service";

describe("MaintenanceModeService", () => {
    const prisma = {
        systemSetting: {
            findUnique: jest.fn(),
            upsert: jest.fn(),
        },
    };

    const cacheService = {
        get: jest.fn(),
        set: jest.fn(),
        del: jest.fn(),
    };

    let service: MaintenanceModeService;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new MaintenanceModeService(prisma as any, cacheService as any);
    });

    it("returns cached maintenance config when available", async () => {
        cacheService.get.mockResolvedValue({ enabled: true, message: "Cached", bypassAdmins: true });

        const result = await service.getMaintenanceConfig();

        expect(result.enabled).toBe(true);
        expect(prisma.systemSetting.findUnique).not.toHaveBeenCalled();
    });

    it("returns default config when setting is missing", async () => {
        cacheService.get.mockResolvedValue(null);
        prisma.systemSetting.findUnique.mockResolvedValue(null);

        const result = await service.getMaintenanceConfig();

        expect(result.enabled).toBe(false);
        expect(result.message).toMatch(/performing maintenance/i);
        expect(cacheService.set).toHaveBeenCalledWith(
            "system:maintenance_mode",
            expect.objectContaining({ enabled: false }),
            30
        );
    });

    it("checks whether maintenance is enabled", async () => {
        jest.spyOn(service, "getMaintenanceConfig").mockResolvedValue({
            enabled: true,
            message: "on",
            bypassAdmins: true,
        });

        await expect(service.isMaintenanceEnabled()).resolves.toBe(true);
    });

    it("enables maintenance mode and invalidates cache", async () => {
        prisma.systemSetting.upsert.mockResolvedValue({});

        const result = await service.enableMaintenance("Deployment", 7, {
            estimatedEndTime: "2026-03-30T00:00:00Z",
            allowedIps: ["127.0.0.1"],
        });

        expect(result.enabled).toBe(true);
        expect(result.allowedIps).toEqual(["127.0.0.1"]);
        expect(prisma.systemSetting.upsert).toHaveBeenCalled();
        expect(cacheService.del).toHaveBeenCalledWith("system:maintenance_mode");
    });

    it("disables maintenance mode", async () => {
        prisma.systemSetting.upsert.mockResolvedValue({});

        const result = await service.disableMaintenance(8);

        expect(result).toEqual({ enabled: false, message: "", bypassAdmins: true });
        expect(cacheService.del).toHaveBeenCalledWith("system:maintenance_mode");
    });

    it("updates maintenance config by merging current values", async () => {
        jest.spyOn(service, "getMaintenanceConfig").mockResolvedValue({
            enabled: true,
            message: "Current",
            bypassAdmins: true,
            allowedIps: ["10.1.1.1"],
        });
        prisma.systemSetting.upsert.mockResolvedValue({});

        const result = await service.updateMaintenanceConfig(
            { message: "Updated", allowedIps: ["10.1.1.2"] },
            11
        );

        expect(result).toEqual(
            expect.objectContaining({
                enabled: true,
                message: "Updated",
                allowedIps: ["10.1.1.2"],
            })
        );
    });

    it("applies bypass rules correctly", async () => {
        jest.spyOn(service, "getMaintenanceConfig")
            .mockResolvedValueOnce({ enabled: false, message: "", bypassAdmins: true })
            .mockResolvedValueOnce({ enabled: true, message: "on", bypassAdmins: true, allowedIps: [] })
            .mockResolvedValueOnce({ enabled: true, message: "on", bypassAdmins: false, allowedIps: ["127.0.0.1"] })
            .mockResolvedValueOnce({ enabled: true, message: "on", bypassAdmins: false, allowedIps: ["10.0.0.1"] });

        await expect(service.shouldBypass("8.8.8.8", false)).resolves.toBe(true);
        await expect(service.shouldBypass("8.8.8.8", true)).resolves.toBe(true);
        await expect(service.shouldBypass("127.0.0.1", false)).resolves.toBe(true);
        await expect(service.shouldBypass("8.8.8.8", false)).resolves.toBe(false);
    });
});