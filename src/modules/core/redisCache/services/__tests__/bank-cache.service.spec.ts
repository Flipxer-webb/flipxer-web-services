import { BankCacheService } from "../bank-cache.service";

describe("BankCacheService", () => {
    let service: BankCacheService;
    let cacheService: {
        get: jest.Mock;
        set: jest.Mock;
        del: jest.Mock;
    };

    beforeEach(() => {
        cacheService = {
            get: jest.fn(),
            set: jest.fn().mockResolvedValue(undefined),
            del: jest.fn().mockResolvedValue(undefined),
        };

        service = new BankCacheService(cacheService as any);

        jest.spyOn((service as any).logger, "debug").mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("returns cached verification on cache hit", async () => {
        const cachedEntry = {
            accountName: "Jane Doe",
            accountNumber: "1234567890",
            bankCode: "057",
            cachedAt: 123,
        };
        cacheService.get.mockResolvedValue(cachedEntry);

        const result = await service.getCachedVerification("057", "1234567890");

        expect(cacheService.get).toHaveBeenCalledWith("bank:verify:057:1234567890");
        expect(result).toEqual(cachedEntry);
    });

    it("returns null on cache miss", async () => {
        cacheService.get.mockResolvedValue(null);

        const result = await service.getCachedVerification("058", "0000111122");

        expect(result).toBeNull();
    });

    it("returns null when cache lookup throws", async () => {
        cacheService.get.mockRejectedValue(new Error("redis unavailable"));

        const result = await service.getCachedVerification("011", "0000111122");

        expect(result).toBeNull();
        expect((service as any).logger.error).toHaveBeenCalled();
    });

    it("caches verification entries with expected key and ttl", async () => {
        const now = 1711111111111;
        jest.spyOn(Date, "now").mockReturnValue(now);

        await service.cacheVerification("044", "1234509876", "John Smith");

        expect(cacheService.set).toHaveBeenCalledWith(
            "bank:verify:044:1234509876",
            {
                accountName: "John Smith",
                accountNumber: "1234509876",
                bankCode: "044",
                cachedAt: now,
            },
            86400,
        );
    });

    it("swallows cache write errors", async () => {
        cacheService.set.mockRejectedValue(new Error("write failed"));

        await expect(
            service.cacheVerification("044", "1234509876", "John Smith"),
        ).resolves.toBeUndefined();

        expect((service as any).logger.error).toHaveBeenCalled();
    });

    it("invalidates cached verification", async () => {
        await service.invalidateCache("033", "1010101010");

        expect(cacheService.del).toHaveBeenCalledWith("bank:verify:033:1010101010");
    });

    it("swallows cache invalidation errors", async () => {
        cacheService.del.mockRejectedValue(new Error("delete failed"));

        await expect(service.invalidateCache("033", "1010101010")).resolves.toBeUndefined();
        expect((service as any).logger.error).toHaveBeenCalled();
    });

    it("returns static cache stats", async () => {
        await expect(service.getCacheStats()).resolves.toEqual({
            prefix: "bank:verify",
            ttlSeconds: 86400,
        });
    });
});
