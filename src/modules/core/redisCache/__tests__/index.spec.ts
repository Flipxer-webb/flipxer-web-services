import { MODULE_METADATA } from "@nestjs/common/constants";

jest.mock("../services/redis-cache.service", () => ({
    RedisCacheService: class RedisCacheServiceStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("../services/distributed-lock.service", () => ({
    DistributedLockService: class DistributedLockServiceStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("../services/quidax-cache.service", () => ({
    QuidaxCacheService: class QuidaxCacheServiceStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("../services/coingecko-cache.service", () => ({
    CoinGeckoCacheService: class CoinGeckoCacheServiceStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("../services/bank-cache.service", () => ({
    BankCacheService: class BankCacheServiceStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("@/modules/factory/trading", () => ({
    TradingFactoryModule: class TradingFactoryModuleStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("@/modules/factory/trading/providers/coingecko/services", () => ({
    CoinGeckoService: class CoinGeckoServiceStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("@/modules/factory/trading/providers/livecoinwatch/services", () => ({
    LiveCoinWatchService: class LiveCoinWatchServiceStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("@/modules/factory/trading/types", () => ({
    TradingInjectionToken: {
        COINGECKO: "COINGECKO_TOKEN",
        LIVECOINWATCH: "LIVECOINWATCH_TOKEN",
    },
    __esModule: true,
}));

jest.mock("@/modules/core/prisma", () => ({
    PrismaModule: class PrismaModuleStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("@/modules/core/email", () => ({
    EmailModule: class EmailModuleStub { readonly stub = true; },
    __esModule: true,
}));

import { CachingModule } from "../index";

describe("CachingModule", () => {
    it("registers expected metadata and provider tokens", () => {
        const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, CachingModule) as Array<any>;
        const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, CachingModule) as Array<any>;
        const exportsMeta = Reflect.getMetadata(MODULE_METADATA.EXPORTS, CachingModule) as Array<any>;

        expect(Array.isArray(imports)).toBe(true);
        expect(Array.isArray(providers)).toBe(true);
        expect(Array.isArray(exportsMeta)).toBe(true);
        expect(imports).toHaveLength(3);

        const forwardRefImport = imports.find((imp) => typeof imp?.forwardRef === "function");
        expect(forwardRefImport).toBeDefined();
        expect(typeof forwardRefImport.forwardRef()).toBe("function");

        const tokenProviders = providers.filter((provider) => provider && typeof provider === "object" && "provide" in provider);
        expect(tokenProviders).toHaveLength(2);
        expect(exportsMeta).toContain("COINGECKO_TOKEN");
        expect(exportsMeta).toContain("LIVECOINWATCH_TOKEN");
    });
});
