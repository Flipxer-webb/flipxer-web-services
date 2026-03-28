import { Test, TestingModule } from "@nestjs/testing";

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class { readonly __stub = true },
    UserNotFoundException: class extends Error {
        status: number;
        constructor(message: string, status: number) {
            super(message);
            this.status = status;
        }
    },
    __esModule: true,
}));

import { AdminUserService } from "../admin";
import { PrismaService } from "@/modules/core/prisma/services";
import { EmailService } from "@/modules/core/email/services";

function makePrisma() {
    const tx = {
        flagged: { update: jest.fn(), create: jest.fn().mockResolvedValue({ id: 50 }) },
        user: { update: jest.fn() },
    };

    return {
        user: {
            count: jest.fn(),
            findUnique: jest.fn(),
            findMany: jest.fn(),
        },
        order: {
            aggregate: jest.fn(),
            findMany: jest.fn(),
            count: jest.fn(),
        },
        ledgerEntry: {
            findMany: jest.fn(),
        },
        $transaction: jest.fn().mockImplementation(async (arg: any) => {
            if (typeof arg === "function") {
                return arg(tx);
            }
            return Promise.all(arg);
        }),
        __tx: tx,
    };
}

describe("AdminUserService", () => {
    let service: AdminUserService;
    let prisma: ReturnType<typeof makePrisma>;

    beforeEach(async () => {
        prisma = makePrisma();

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                AdminUserService,
                { provide: PrismaService, useValue: prisma },
                { provide: EmailService, useValue: { sendMail: jest.fn() } },
            ],
        }).compile();

        service = module.get(AdminUserService);
    });

    afterEach(() => jest.clearAllMocks());

    it("should return analytics overview", async () => {
        prisma.user.count.mockResolvedValueOnce(100).mockResolvedValueOnce(15);
        prisma.order.aggregate
            .mockResolvedValueOnce({ _sum: { amountInFiat: 900000 } })
            .mockResolvedValueOnce({ _sum: { amountInFiat: 120000 } });

        const result = await service.getAnalyticsOverview("month");

        expect(result.data.totalUsers).toBe(100);
        expect(result.data.usersInPeriod).toBe(15);
        expect(result.data.totalTransactionVolume).toBe(900000);
    });

    it("should return filtered user stats with explicit status and tier", async () => {
        prisma.user.count.mockResolvedValue(7);

        const result = await service.getUserFilteredStats({ status: "ACTIVE", tier: "1" } as any);

        expect(result.data).toEqual({ total: 7, active: 7, verified: 7, pendingKyc: 0 });
    });

    it("should return user info with withdrawal limit", async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 9, tier: 1, firstName: "Test", lastName: "User", flaggedRecord: null });

        const result = await service.getUserInfo(9);

        expect(result.message).toContain("personal info");
        expect(result.data.id).toBe(9);
        expect(result.data.withdrawalLimit).toBeDefined();
    });

    it("should return not-flagged response when unflagging a clean account", async () => {
        prisma.user.findUnique.mockResolvedValue({
            id: 2,
            flaggedId: 11,
            flaggedRecord: { flagged: false, reason: "" },
        });

        const result = await service.unflagUser({ id: 2 } as any);

        expect(result.message).toContain("not flagged");
        expect(result.data.flaggedRecord.flagged).toBe(false);
    });

    it("should flag a user by creating flagged record when missing", async () => {
        prisma.user.findUnique.mockResolvedValue({
            id: 3,
            flaggedId: null,
            flaggedRecord: null,
        });

        const result = await service.flagUser({ id: 3, reason: "risk" } as any);

        expect(prisma.$transaction).toHaveBeenCalled();
        expect(result.message).toContain("flagged successfully");
        expect(result.data.flaggedRecord.reason).toBe("risk");
    });

    it("should get user list with has_balance filter", async () => {
        prisma.ledgerEntry.findMany.mockResolvedValue([
            { userId: 1, balanceAfter: 10 },
            { userId: 2, balanceAfter: 0 },
        ]);
        prisma.user.findMany.mockResolvedValue([{ id: 1, firstName: "A", lastName: "B" }]);
        prisma.user.count.mockResolvedValue(1);

        const result = await service.getUserList({
            balanceFilter: "has_balance",
            sortBy: "desc",
            paginated: "true",
            pageNumber: 1,
            pageSize: 10,
        } as any);

        expect(result.message).toContain("Users list retrieved");
        expect(result.data.meta).toBeDefined();
    });

    it("should sort user list by highest balance first", async () => {
        prisma.ledgerEntry.findMany.mockResolvedValue([
            { userId: 1, balanceAfter: 20 },
            { userId: 2, balanceAfter: 200 },
        ]);
        prisma.user.findMany
            .mockResolvedValueOnce([{ id: 1 }, { id: 2 }])
            .mockResolvedValueOnce([
                { id: 1, firstName: "Low", lastName: "Bal" },
                { id: 2, firstName: "High", lastName: "Bal" },
            ]);

        const result = await service.getUserList({
            balanceFilter: "highest_first",
            sortBy: "desc",
        } as any);

        expect(result.data.records[0].id).toBe(2);
        expect(result.data.records[1].id).toBe(1);
    });

    it("should compute filtered stats without explicit status/tier", async () => {
        prisma.user.count
            .mockResolvedValueOnce(10) // total
            .mockResolvedValueOnce(7) // active
            .mockResolvedValueOnce(6) // verified
            .mockResolvedValueOnce(4); // pending

        const result = await service.getUserFilteredStats({} as any);

        expect(result.data).toEqual({ total: 10, active: 7, verified: 6, pendingKyc: 4 });
    });

    it("should throw when getUserInfo user does not exist", async () => {
        prisma.user.findUnique.mockResolvedValue(null);

        await expect(service.getUserInfo(404)).rejects.toThrow("User not found");
    });

    it("should return paginated user transaction list", async () => {
        prisma.order.findMany.mockResolvedValue([
            {
                id: 1,
                userId: 7,
                transactionId: "TX-7",
                orderCategory: "BUY",
                status: "completed",
                streamlinedStatus: "completed",
                amount: 100,
                currency: "BTC",
                createdAt: new Date("2026-01-01T00:00:00Z"),
                updatedAt: new Date("2026-01-01T00:00:00Z"),
                user: { firstName: "A", lastName: "B" },
            },
        ] as any);
        prisma.order.count.mockResolvedValue(1);

        const result = await service.getUserTransactionList(
            { paginated: "true", pageNumber: 1, pageSize: 10, sortBy: "desc" } as any,
            7,
        );

        expect(result.message).toContain("Transactions retrieved");
        expect(result.data.meta).toBeDefined();
        expect(result.data.records).toHaveLength(1);
    });

    it("should throw when unflagging non-existent user", async () => {
        prisma.user.findUnique.mockResolvedValue(null);

        await expect(service.unflagUser({ id: 90 } as any)).rejects.toThrow("Account with ID not found");
    });

    it("should unflag existing flagged record via update path", async () => {
        prisma.user.findUnique.mockResolvedValue({
            id: 5,
            flaggedId: 21,
            flaggedRecord: { flagged: true, reason: "risk" },
        });

        const result = await service.unflagUser({ id: 5 } as any);

        expect(prisma.__tx.flagged.update).toHaveBeenCalled();
        expect(result.message).toContain("unflagged successfully");
    });

    it("should return already flagged in flagUser", async () => {
        prisma.user.findUnique.mockResolvedValue({
            id: 5,
            flaggedId: 21,
            flaggedRecord: { flagged: true, reason: "risk" },
        });

        const result = await service.flagUser({ id: 5, reason: "new" } as any);

        expect(result.message).toContain("already flagged");
        expect(result.data.flaggedRecord.reason).toBe("risk");
    });

    it("should flag user via update path when flaggedId exists", async () => {
        prisma.user.findUnique.mockResolvedValue({
            id: 6,
            flaggedId: 31,
            flaggedRecord: { flagged: false, reason: "" },
        });

        const result = await service.flagUser({ id: 6, reason: "aml" } as any);

        expect(prisma.__tx.flagged.update).toHaveBeenCalled();
        expect(result.data.flaggedRecord).toEqual({ flagged: true, reason: "aml" });
    });
});