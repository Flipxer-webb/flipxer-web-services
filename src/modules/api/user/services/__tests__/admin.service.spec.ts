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
});