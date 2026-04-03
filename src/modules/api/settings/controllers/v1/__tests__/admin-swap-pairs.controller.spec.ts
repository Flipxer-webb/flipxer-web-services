jest.mock("@/modules/api/auth/guard", () => ({
    AuthGuard: class { isStub() { return true; } },
    EnabledAccountGuard: class { isStub() { return true; } },
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/guards/role.guard", () => ({
    RoleGuard: class { isStub() { return true; } },
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/decorator", () => ({
    UserTypes: () => () => undefined,
    ADMIN_USER_TYPES: ["SUPER_ADMIN"],
    __esModule: true,
}));

import { SUPPORTED_ASSETS } from "@/modules/api/trade/constants";
import { AdminSwapPairController } from "../admin-swap-pairs.controller";

describe("AdminSwapPairController", () => {
    let controller: AdminSwapPairController;
    let prisma: {
        $transaction: jest.Mock;
        swapPair: {
            findMany: jest.Mock;
            upsert: jest.Mock;
            updateMany: jest.Mock;
        };
    };

    beforeEach(() => {
        prisma = {
            $transaction: jest.fn(),
            swapPair: {
                findMany: jest.fn(),
                upsert: jest.fn(),
                updateMany: jest.fn(),
            },
        };

        controller = new AdminSwapPairController(prisma as any);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it("lists swap pairs sorted by currencies", async () => {
        prisma.swapPair.findMany.mockResolvedValue([{ fromCurrency: "BTC", toCurrency: "USDT" }]);

        const result = await controller.getSwapPairs();

        expect(prisma.swapPair.findMany).toHaveBeenCalledWith({
            orderBy: [{ fromCurrency: "asc" }, { toCurrency: "asc" }],
        });
        expect(result.message).toBe("Swap pairs retrieved");
        expect(result.data).toEqual([{ fromCurrency: "BTC", toCurrency: "USDT" }]);
    });

    it("upserts a swap pair and defaults isActive to true", async () => {
        prisma.swapPair.upsert.mockResolvedValue({ id: 1 });

        await controller.upsertSwapPair({
            fromCurrency: "BTC",
            toCurrency: "USDT",
            rate: 123,
        } as any);

        expect(prisma.swapPair.upsert).toHaveBeenCalledWith({
            where: {
                fromCurrency_toCurrency: {
                    fromCurrency: "BTC",
                    toCurrency: "USDT",
                },
            },
            update: {
                rate: 123,
                isActive: true,
            },
            create: {
                fromCurrency: "BTC",
                toCurrency: "USDT",
                rate: 123,
                isActive: true,
            },
        });
    });

    it("upserts a swap pair with explicit isActive", async () => {
        prisma.swapPair.upsert.mockResolvedValue({ id: 2 });

        const result = await controller.upsertSwapPair({
            fromCurrency: "ETH",
            toCurrency: "BTC",
            rate: 42,
            isActive: false,
        } as any);

        expect(prisma.swapPair.upsert).toHaveBeenCalledWith(expect.objectContaining({
            update: { rate: 42, isActive: false },
            create: {
                fromCurrency: "ETH",
                toCurrency: "BTC",
                rate: 42,
                isActive: false,
            },
        }));
        expect(result.message).toBe("Swap pair updated");
    });

    it("generates all missing pair permutations", async () => {
        const tx = {
            swapPair: {
                findUnique: jest.fn().mockResolvedValue(null),
                create: jest.fn().mockResolvedValue(undefined),
            },
        };

        prisma.$transaction.mockImplementation(async (cb: any) => cb(tx));

        const result = await controller.generateAllPairs();
        const assetsCount = Array.from(SUPPORTED_ASSETS).length;
        const expectedPermutations = assetsCount * (assetsCount - 1);

        expect(tx.swapPair.findUnique).toHaveBeenCalledTimes(expectedPermutations);
        expect(tx.swapPair.create).toHaveBeenCalledTimes(expectedPermutations);
        expect(result.data).toBe(expectedPermutations);
        expect(result.message).toContain("Generated");
    });

    it("bulk updates matched pairs with rate multiplier", async () => {
        prisma.swapPair.findMany.mockResolvedValue([
            { fromCurrency: "USDT", toCurrency: "BTC", rate: 10 },
            { fromCurrency: "BTC", toCurrency: "USDT", rate: 0 },
            { fromCurrency: "USDT", toCurrency: "ETH", rate: 15 },
        ]);

        const tx = {
            swapPair: {
                update: jest.fn().mockResolvedValue(undefined),
            },
        };
        prisma.$transaction.mockImplementation(async (cb: any) => cb(tx));

        const result = await controller.bulkUpdate({
            targetCurrency: "usdt",
            rateMultiplier: 2,
            isActive: true,
        } as any);

        expect(prisma.swapPair.findMany).toHaveBeenCalledWith({
            where: {
                OR: [{ fromCurrency: "USDT" }, { toCurrency: "USDT" }],
            },
        });
        expect(tx.swapPair.update).toHaveBeenCalledTimes(2);
        expect(tx.swapPair.update).toHaveBeenCalledWith({
            where: { fromCurrency_toCurrency: { fromCurrency: "USDT", toCurrency: "BTC" } },
            data: { rate: 20, isActive: true },
        });
        expect(tx.swapPair.update).toHaveBeenCalledWith({
            where: { fromCurrency_toCurrency: { fromCurrency: "USDT", toCurrency: "ETH" } },
            data: { rate: 30, isActive: true },
        });
        expect(result.message).toContain("Bulk updated rates for 2 pairs related to USDT");
    });

    it("bulk updates matched pairs without rate multiplier", async () => {
        prisma.swapPair.updateMany.mockResolvedValue({ count: 5 });

        const result = await controller.bulkUpdate({
            targetCurrency: "btc",
            isActive: false,
        } as any);

        expect(prisma.swapPair.updateMany).toHaveBeenCalledWith({
            where: {
                OR: [{ fromCurrency: "BTC" }, { toCurrency: "BTC" }],
            },
            data: {
                isActive: false,
            },
        });
        expect(result.message).toBe("Bulk updated 5 pairs related to BTC.");
        expect(result.data).toEqual({ count: 5 });
    });
});
