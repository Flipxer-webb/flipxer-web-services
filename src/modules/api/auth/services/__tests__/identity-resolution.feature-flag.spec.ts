import { IdentityIdType } from "@prisma/client";

describe("IdentityResolutionService feature flag", () => {
    afterEach(() => {
        jest.resetModules();
        jest.dontMock("@/config");
    });

    it("skips graph resolution when dedup feature flag is disabled", async () => {
        jest.resetModules();

        jest.doMock("@/config", () => ({
            DB_TRANSACTION_TIMEOUT: 10000,
            IDENTITY_DEDUP_ENABLED: false,
        }));

        const { IdentityResolutionService } = await import("../identity-resolution.service");

        const prisma = {
            $transaction: jest.fn(),
            user: { findUnique: jest.fn() },
        } as any;

        const service = new IdentityResolutionService(prisma);

        await expect(
            service.resolveOrCreate(IdentityIdType.BVN, "22345678901", 1),
        ).resolves.toEqual({ subjectId: 0, isNew: false });

        expect(prisma.$transaction).not.toHaveBeenCalled();
    });
});
