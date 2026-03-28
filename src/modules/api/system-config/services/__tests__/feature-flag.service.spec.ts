import { Test, TestingModule } from "@nestjs/testing";

import { FeatureFlagService } from "../feature-flag.service";
import { PrismaService } from "@/modules/core/prisma/services";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";

function makePrisma() {
    return {
        featureFlag: {
            create: jest.fn(),
            findUnique: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
            findMany: jest.fn(),
        },
        featureFlagAuditLog: {
            create: jest.fn(),
            findMany: jest.fn(),
        },
    };
}

describe("FeatureFlagService", () => {
    let service: FeatureFlagService;
    let prisma: ReturnType<typeof makePrisma>;
    let cache: { get: jest.Mock; set: jest.Mock; del: jest.Mock };

    beforeEach(async () => {
        prisma = makePrisma();
        cache = { get: jest.fn(), set: jest.fn(), del: jest.fn() };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                FeatureFlagService,
                { provide: PrismaService, useValue: prisma },
                { provide: RedisCacheService, useValue: cache },
            ],
        }).compile();

        service = module.get(FeatureFlagService);
    });

    afterEach(() => jest.clearAllMocks());

    it("should create a flag and audit it", async () => {
        prisma.featureFlag.create.mockResolvedValue({ id: 1, key: "beta-ui" });

        const result = await service.createFlag({ key: "beta-ui", name: "Beta UI", isEnabled: true } as any, 99, "admin@flipxer.com");

        expect(prisma.featureFlag.create).toHaveBeenCalled();
        expect(prisma.featureFlagAuditLog.create).toHaveBeenCalled();
        expect(result.key).toBe("beta-ui");
    });

    it("should update a flag, log audit, and invalidate cache", async () => {
        prisma.featureFlag.findUnique.mockResolvedValue({ id: 1, key: "beta-ui", isEnabled: false, conditions: null });
        prisma.featureFlag.update.mockResolvedValue({ id: 1, key: "beta-ui", isEnabled: true, conditions: null });

        const result = await service.updateFlag(1, { isEnabled: true } as any, 99);

        expect(prisma.featureFlagAuditLog.create).toHaveBeenCalled();
        expect(cache.del).toHaveBeenCalledWith("system:feature_flag:beta-ui");
        expect(result.isEnabled).toBe(true);
    });

    it("should get flag by key from cache when available", async () => {
        cache.get.mockResolvedValue({ key: "cached-flag", isEnabled: true });

        const result = await service.getFlagByKey("cached-flag");

        expect(result.key).toBe("cached-flag");
        expect(prisma.featureFlag.findUnique).not.toHaveBeenCalled();
    });

    it("should cache db-loaded flag by key", async () => {
        cache.get.mockResolvedValue(null);
        prisma.featureFlag.findUnique.mockResolvedValue({ key: "db-flag", isEnabled: true });

        const result = await service.getFlagByKey("db-flag");

        expect(prisma.featureFlag.findUnique).toHaveBeenCalledWith({ where: { key: "db-flag" } });
        expect(cache.set).toHaveBeenCalled();
        expect(result.key).toBe("db-flag");
    });

    it("should evaluate flag conditions correctly", async () => {
        jest.spyOn(service, "getFlagByKey").mockResolvedValue({
            key: "rollout",
            isEnabled: true,
            conditions: {
                allowedUserIds: [5],
                excludeCountries: ["US"],
                minTier: 1,
            },
        } as any);

        await expect(service.evaluateFlag("rollout", { userId: 5, userCountry: "NG", userTier: 2 } as any)).resolves.toBe(true);
        await expect(service.evaluateFlag("rollout", { userId: 6, userCountry: "US", userTier: 2 } as any)).resolves.toBe(false);
        await expect(service.evaluateFlag("rollout", { userId: 6, userCountry: "NG", userTier: 0 } as any)).resolves.toBe(false);
    });

    it("should bulk evaluate flags", async () => {
        jest.spyOn(service, "evaluateFlag")
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false);

        const result = await service.evaluateFlags(["a", "b"], { userId: 1 } as any);

        expect(result).toEqual({ a: true, b: false });
    });

    it("should delete a flag and invalidate cache", async () => {
        prisma.featureFlag.findUnique.mockResolvedValue({ id: 4, key: "old-flag" });

        await service.deleteFlag(4, 88);

        expect(prisma.featureFlag.delete).toHaveBeenCalledWith({ where: { id: 4 } });
        expect(cache.del).toHaveBeenCalledWith("system:feature_flag:old-flag");
    });
});