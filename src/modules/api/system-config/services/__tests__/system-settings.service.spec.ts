import { SystemSettingsService } from "../system-settings.service";

describe("SystemSettingsService", () => {
    const prisma = {
        systemSetting: {
            findUnique: jest.fn(),
            upsert: jest.fn(),
            delete: jest.fn(),
            findMany: jest.fn(),
        },
        $transaction: jest.fn(),
    };

    const cacheService = {
        get: jest.fn(),
        set: jest.fn(),
        del: jest.fn(),
    };

    let service: SystemSettingsService;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new SystemSettingsService(prisma as any, cacheService as any);
    });

    it("returns cached setting when found in cache", async () => {
        cacheService.get.mockResolvedValue({ enabled: true });

        const result = await service.getSetting("feature_x");

        expect(result).toEqual({ enabled: true });
        expect(prisma.systemSetting.findUnique).not.toHaveBeenCalled();
    });

    it("loads setting from DB and writes to cache", async () => {
        cacheService.get.mockResolvedValue(null);
        prisma.systemSetting.findUnique.mockResolvedValue({
            key: "feature_x",
            value: { enabled: false },
        });

        const result = await service.getSetting("feature_x");

        expect(result).toEqual({ enabled: false });
        expect(cacheService.set).toHaveBeenCalledWith(
            "system:settings:feature_x",
            { enabled: false },
            60
        );
    });

    it("returns null when setting does not exist", async () => {
        cacheService.get.mockResolvedValue(null);
        prisma.systemSetting.findUnique.mockResolvedValue(null);

        await expect(service.getSetting("missing")).resolves.toBeNull();
    });

    it("upserts a setting and invalidates cache", async () => {
        prisma.systemSetting.upsert.mockResolvedValue({});

        await service.setSetting(
            { key: "kyc_rules", value: { maxRetries: 3 }, description: "KYC policies" },
            33
        );

        expect(prisma.systemSetting.upsert).toHaveBeenCalled();
        expect(cacheService.del).toHaveBeenCalledWith("system:settings:kyc_rules");
    });

    it("deletes setting and invalidates cache", async () => {
        prisma.systemSetting.delete.mockResolvedValue({});

        await service.deleteSetting("old_rule");

        expect(prisma.systemSetting.delete).toHaveBeenCalledWith({ where: { key: "old_rule" } });
        expect(cacheService.del).toHaveBeenCalledWith("system:settings:old_rule");
    });

    it("gets all settings ordered by key", async () => {
        prisma.systemSetting.findMany.mockResolvedValue([{ key: "a" }, { key: "b" }]);

        const result = await service.getAllSettings();

        expect(prisma.systemSetting.findMany).toHaveBeenCalledWith({ orderBy: { key: "asc" } });
        expect(result).toHaveLength(2);
    });

    it("gets settings by prefix", async () => {
        prisma.systemSetting.findMany.mockResolvedValue([{ key: "trade.limit" }]);

        const result = await service.getSettingsByPrefix("trade.");

        expect(prisma.systemSetting.findMany).toHaveBeenCalledWith({
            where: { key: { startsWith: "trade." } },
            orderBy: { key: "asc" },
        });
        expect(result).toEqual([{ key: "trade.limit" }]);
    });

    it("bulk updates settings and invalidates caches", async () => {
        prisma.systemSetting.upsert.mockImplementation((arg: any) => arg);
        prisma.$transaction.mockResolvedValue([]);

        const settings = [
            { key: "limits.withdrawal", value: 2000, description: "max" },
            { key: "limits.trade", value: 1000, description: "min" },
        ];

        await service.bulkUpdateSettings(settings as any, 44);

        expect(prisma.$transaction).toHaveBeenCalled();
        expect(cacheService.del).toHaveBeenCalledWith("system:settings:limits.withdrawal");
        expect(cacheService.del).toHaveBeenCalledWith("system:settings:limits.trade");
    });
});