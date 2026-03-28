import { Test, TestingModule } from "@nestjs/testing";

// Break circular dependency
jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class { readonly __stub = true },
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    __esModule: true,
}));

import { LedgerService } from "../ledger.service";
import { PrismaService } from "@/modules/core/prisma/services";
import { DistributedLockService } from "@/modules/core/redisCache/services/distributed-lock.service";
import { LedgerType, EntryStatus, SweepStatus, AuditAction } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";

// ── Mock factories ──────────────────────────────────────────

function makeTxClient() {
    return {
        ledgerEntry: {
            findUnique: jest.fn(),
            findFirst: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            aggregate: jest.fn().mockResolvedValue({ _sum: { holdAmount: null } }),
        },
        ledgerAuditLog: {
            create: jest.fn().mockResolvedValue({ id: "audit-1" }),
        },
    };
}

function makePrisma() {
    const tx = makeTxClient();
    return {
        $transaction: jest.fn().mockImplementation(async (cb: any) => cb(tx)),
        ledgerEntry: {
            findFirst: jest.fn(),
            findMany: jest.fn(),
            findUnique: jest.fn(),
            aggregate: jest.fn().mockResolvedValue({ _sum: { holdAmount: null } }),
        },
        ledgerAuditLog: {
            create: jest.fn().mockResolvedValue({ id: "audit-1" }),
        },
        _tx: tx, // exposed for assertions
    };
}

function makeLockService() {
    return {
        withLock: jest.fn().mockImplementation(async (_key: string, fn: () => Promise<any>) => fn()),
    };
}

// ── Suite ────────────────────────────────────────────────────

describe("LedgerService", () => {
    let service: LedgerService;
    let prisma: ReturnType<typeof makePrisma>;
    let lockService: ReturnType<typeof makeLockService>;
    let tx: ReturnType<typeof makeTxClient>;

    beforeEach(async () => {
        prisma = makePrisma();
        lockService = makeLockService();
        tx = prisma._tx;

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                LedgerService,
                { provide: PrismaService, useValue: prisma },
                { provide: DistributedLockService, useValue: lockService },
            ],
        }).compile();

        service = module.get(LedgerService);
    });

    afterEach(() => jest.clearAllMocks());

    // ── credit ───────────────────────────────────────────────

    describe("credit", () => {
        const opts = {
            userId: 1,
            currency: "BTC",
            type: LedgerType.DEPOSIT,
            amount: "0.5",
            reference: "dep-001",
        };

        it("should create a credit entry and return new balance", async () => {
            tx.ledgerEntry.findUnique.mockResolvedValue(null); // no duplicate
            tx.ledgerEntry.findFirst.mockResolvedValue(null); // no prior balance
            tx.ledgerEntry.create.mockResolvedValue({
                id: "entry-1",
                balanceAfter: new Decimal("0.5"),
            });

            const result = await service.credit(opts);

            expect(result.success).toBe(true);
            expect(result.entryId).toBe("entry-1");
            expect(tx.ledgerEntry.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        userId: 1,
                        currency: "BTC",
                        type: LedgerType.DEPOSIT,
                        credit: new Decimal("0.5"),
                        debit: new Decimal(0),
                        status: EntryStatus.SETTLED,
                    }),
                }),
            );
        });

        it("should use distributed lock with user:currency key", async () => {
            tx.ledgerEntry.findUnique.mockResolvedValue(null);
            tx.ledgerEntry.findFirst.mockResolvedValue(null);
            tx.ledgerEntry.create.mockResolvedValue({ id: "e1", balanceAfter: new Decimal("0.5") });

            await service.credit(opts);

            expect(lockService.withLock).toHaveBeenCalledWith(
                "ledger:1:BTC",
                expect.any(Function),
                expect.objectContaining({ ttlMs: 10000 }),
            );
        });

        it("should add to existing balance", async () => {
            tx.ledgerEntry.findUnique.mockResolvedValue(null);
            tx.ledgerEntry.findFirst.mockResolvedValue({ balanceAfter: new Decimal("1.0") });
            tx.ledgerEntry.create.mockResolvedValue({ id: "e2", balanceAfter: new Decimal("1.5") });

            const result = await service.credit(opts);

            expect(result.success).toBe(true);
            expect(tx.ledgerEntry.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        balanceAfter: new Decimal("1.5"),
                    }),
                }),
            );
        });

        it("should return existing entry on duplicate reference (idempotent)", async () => {
            tx.ledgerEntry.findUnique.mockResolvedValue({
                id: "existing-1",
                balanceAfter: new Decimal("0.5"),
            });

            const result = await service.credit(opts);

            expect(result.success).toBe(true);
            expect(result.entryId).toBe("existing-1");
            expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
        });

        it("should reject zero amount", async () => {
            const result = await service.credit({ ...opts, amount: "0" });

            expect(result.success).toBe(false);
            expect(result.error).toContain("must be positive");
            expect(lockService.withLock).not.toHaveBeenCalled();
        });

        it("should reject negative amount", async () => {
            const result = await service.credit({ ...opts, amount: "-1" });

            expect(result.success).toBe(false);
            expect(result.error).toContain("must be positive");
        });

        it("should uppercase the currency", async () => {
            tx.ledgerEntry.findUnique.mockResolvedValue(null);
            tx.ledgerEntry.findFirst.mockResolvedValue(null);
            tx.ledgerEntry.create.mockResolvedValue({ id: "e3", balanceAfter: new Decimal("0.5") });

            await service.credit({ ...opts, currency: "btc" });

            expect(tx.ledgerEntry.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ currency: "BTC" }),
                }),
            );
        });

        it("should set PENDING sweep status for deposits", async () => {
            tx.ledgerEntry.findUnique.mockResolvedValue(null);
            tx.ledgerEntry.findFirst.mockResolvedValue(null);
            tx.ledgerEntry.create.mockResolvedValue({ id: "e4", balanceAfter: new Decimal("0.5") });

            await service.credit({ ...opts, type: LedgerType.DEPOSIT });

            expect(tx.ledgerEntry.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ sweepStatus: SweepStatus.PENDING }),
                }),
            );
        });

        it("should return error when lock fails", async () => {
            lockService.withLock.mockRejectedValue(new Error("Failed to acquire lock"));

            const result = await service.credit(opts);

            expect(result.success).toBe(false);
            expect(result.error).toContain("Failed to acquire lock");
        });

        it("should create audit log entry", async () => {
            tx.ledgerEntry.findUnique.mockResolvedValue(null);
            tx.ledgerEntry.findFirst.mockResolvedValue(null);
            tx.ledgerEntry.create.mockResolvedValue({ id: "e5", balanceAfter: new Decimal("0.5") });

            await service.credit(opts);

            expect(tx.ledgerAuditLog.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        ledgerEntryId: "e5",
                        action: AuditAction.CREATED,
                    }),
                }),
            );
        });
    });

    // ── debit ────────────────────────────────────────────────

    describe("debit", () => {
        const opts = {
            userId: 1,
            currency: "BTC",
            type: LedgerType.WITHDRAWAL,
            amount: "0.3",
            reference: "wth-001",
        };

        it("should create a debit entry when balance is sufficient", async () => {
            tx.ledgerEntry.findUnique.mockResolvedValue(null);
            tx.ledgerEntry.findFirst.mockResolvedValue({ balanceAfter: new Decimal("1.0") });
            tx.ledgerEntry.aggregate.mockResolvedValue({ _sum: { holdAmount: null } });
            tx.ledgerEntry.create.mockResolvedValue({ id: "d1", balanceAfter: new Decimal("0.7") });

            const result = await service.debit(opts);

            expect(result.success).toBe(true);
            expect(tx.ledgerEntry.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        debit: new Decimal("0.3"),
                        credit: new Decimal(0),
                        balanceAfter: new Decimal("0.7"),
                    }),
                }),
            );
        });

        it("should fail when available balance is insufficient", async () => {
            tx.ledgerEntry.findUnique.mockResolvedValue(null);
            tx.ledgerEntry.findFirst.mockResolvedValue({ balanceAfter: new Decimal("0.1") });
            tx.ledgerEntry.aggregate.mockResolvedValue({ _sum: { holdAmount: null } });

            const result = await service.debit(opts);

            expect(result.success).toBe(false);
            expect(result.error).toContain("Insufficient balance");
            expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
        });

        it("should account for held amounts in available balance", async () => {
            tx.ledgerEntry.findUnique.mockResolvedValue(null);
            tx.ledgerEntry.findFirst.mockResolvedValue({ balanceAfter: new Decimal("1.0") });
            // 0.8 held, only 0.2 available — requesting 0.3 should fail
            tx.ledgerEntry.aggregate.mockResolvedValue({ _sum: { holdAmount: new Decimal("0.8") } });

            const result = await service.debit(opts);

            expect(result.success).toBe(false);
            expect(result.error).toContain("Insufficient balance");
        });

        it("should allow platform account (userId=0) to go negative", async () => {
            tx.ledgerEntry.findUnique.mockResolvedValue(null);
            tx.ledgerEntry.findFirst.mockResolvedValue({ balanceAfter: new Decimal("0.1") });
            tx.ledgerEntry.aggregate.mockResolvedValue({ _sum: { holdAmount: null } });
            tx.ledgerEntry.create.mockResolvedValue({
                id: "d-platform",
                balanceAfter: new Decimal("-0.2"),
            });

            const result = await service.debit({
                ...opts,
                userId: 0, // platform account
            });

            expect(result.success).toBe(true);
            expect(tx.ledgerEntry.create).toHaveBeenCalled();
        });

        it("should be idempotent on duplicate reference", async () => {
            tx.ledgerEntry.findUnique.mockResolvedValue({
                id: "existing-d1",
                balanceAfter: new Decimal("0.7"),
            });

            const result = await service.debit(opts);

            expect(result.success).toBe(true);
            expect(result.entryId).toBe("existing-d1");
            expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
        });

        it("should reject zero amount", async () => {
            const result = await service.debit({ ...opts, amount: "0" });

            expect(result.success).toBe(false);
            expect(result.error).toContain("must be positive");
        });
    });

    // ── hold ─────────────────────────────────────────────────

    describe("hold", () => {
        const opts = {
            userId: 1,
            currency: "BTC",
            type: LedgerType.HOLD,
            amount: "0.2",
            reference: "hold-001",
        };

        it("should create a hold entry with holdAmount and HOLD status", async () => {
            tx.ledgerEntry.findUnique.mockResolvedValue(null);
            tx.ledgerEntry.findFirst.mockResolvedValue({ balanceAfter: new Decimal("1.0") });
            tx.ledgerEntry.aggregate.mockResolvedValue({ _sum: { holdAmount: null } });
            tx.ledgerEntry.create.mockResolvedValue({
                id: "h1",
                balanceAfter: new Decimal("1.0"),
                holdAmount: new Decimal("0.2"),
            });

            const result = await service.hold(opts);

            expect(result.success).toBe(true);
            expect(tx.ledgerEntry.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        status: EntryStatus.HOLD,
                        holdAmount: new Decimal("0.2"),
                        debit: new Decimal(0),
                        credit: new Decimal(0),
                        balanceAfter: new Decimal("1.0"), // total unchanged
                    }),
                }),
            );
        });

        it("should fail when available balance is insufficient for hold", async () => {
            tx.ledgerEntry.findUnique.mockResolvedValue(null);
            tx.ledgerEntry.findFirst.mockResolvedValue({ balanceAfter: new Decimal("0.1") });
            tx.ledgerEntry.aggregate.mockResolvedValue({ _sum: { holdAmount: null } });

            const result = await service.hold(opts);

            expect(result.success).toBe(false);
            expect(result.error).toContain("Insufficient balance for hold");
        });

        it("should reject zero hold amount", async () => {
            const result = await service.hold({ ...opts, amount: "0" });

            expect(result.success).toBe(false);
            expect(result.error).toContain("must be positive");
        });

        it("should be idempotent on duplicate reference", async () => {
            tx.ledgerEntry.findUnique.mockResolvedValue({
                id: "existing-h1",
                balanceAfter: new Decimal("1.0"),
            });

            const result = await service.hold(opts);

            expect(result.success).toBe(true);
            expect(result.entryId).toBe("existing-h1");
            expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
        });
    });

    // ── releaseHold ──────────────────────────────────────────

    describe("releaseHold", () => {
        const holdEntry = {
            id: "hold-entry-1",
            userId: 1,
            currency: "BTC",
            balanceAfter: new Decimal("1.0"),
            holdAmount: new Decimal("0.2"),
            status: EntryStatus.HOLD,
            reference: "hold-ref-1",
        };

        it("should settle a hold (convert to debit, reduce balance)", async () => {
            prisma.ledgerEntry.findFirst.mockResolvedValue(holdEntry);
            tx.ledgerEntry.findUnique.mockResolvedValue(holdEntry);
            tx.ledgerEntry.update.mockResolvedValue({
                ...holdEntry,
                id: holdEntry.id,
                debit: holdEntry.holdAmount,
                holdAmount: new Decimal(0),
                balanceAfter: new Decimal("0.8"),
                status: EntryStatus.SETTLED,
            });

            const result = await service.releaseHold("hold-ref-1", true);

            expect(result.success).toBe(true);
            expect(result.balanceAfter).toEqual(new Decimal("0.8"));
            expect(tx.ledgerEntry.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: "hold-entry-1" },
                    data: expect.objectContaining({
                        debit: new Decimal("0.2"),
                        holdAmount: new Decimal(0),
                        status: EntryStatus.SETTLED,
                    }),
                }),
            );
        });

        it("should release a hold without debit (refund)", async () => {
            prisma.ledgerEntry.findFirst.mockResolvedValue(holdEntry);
            tx.ledgerEntry.findUnique.mockResolvedValue(holdEntry);
            tx.ledgerEntry.update.mockResolvedValue({
                ...holdEntry,
                id: holdEntry.id,
                holdAmount: new Decimal(0),
                status: EntryStatus.CANCELLED,
            });

            const result = await service.releaseHold("hold-ref-1", false);

            expect(result.success).toBe(true);
            expect(tx.ledgerEntry.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        holdAmount: new Decimal(0),
                        status: EntryStatus.CANCELLED,
                    }),
                }),
            );
        });

        it("should return error when hold entry not found", async () => {
            prisma.ledgerEntry.findFirst.mockResolvedValue(null);

            const result = await service.releaseHold("nonexistent", true);

            expect(result.success).toBe(false);
            expect(result.error).toContain("Hold entry not found");
        });

        it("should return success when hold already released", async () => {
            const alreadySettled = { ...holdEntry, status: EntryStatus.SETTLED };
            prisma.ledgerEntry.findFirst.mockResolvedValue(holdEntry);
            tx.ledgerEntry.findUnique.mockResolvedValue(alreadySettled);

            const result = await service.releaseHold("hold-ref-1", true);

            expect(result.success).toBe(true);
            expect(tx.ledgerEntry.update).not.toHaveBeenCalled();
        });
    });

    // ── getBalance ───────────────────────────────────────────

    describe("getBalance", () => {
        it("should return zero balance for user with no entries", async () => {
            prisma.ledgerEntry.findFirst.mockResolvedValue(null);
            prisma.ledgerEntry.aggregate.mockResolvedValue({ _sum: { holdAmount: null } });

            const balance = await service.getBalance(1, "BTC");

            expect(balance.total).toEqual(new Decimal(0));
            expect(balance.held).toEqual(new Decimal(0));
            expect(balance.available).toEqual(new Decimal(0));
        });

        it("should return correct balance from last entry", async () => {
            prisma.ledgerEntry.findFirst.mockResolvedValue({
                balanceAfter: new Decimal("5.0"),
            });
            prisma.ledgerEntry.aggregate.mockResolvedValue({ _sum: { holdAmount: null } });

            const balance = await service.getBalance(1, "BTC");

            expect(balance.total).toEqual(new Decimal("5.0"));
            expect(balance.available).toEqual(new Decimal("5.0"));
            expect(balance.held).toEqual(new Decimal(0));
        });

        it("should subtract held amount from available balance", async () => {
            prisma.ledgerEntry.findFirst.mockResolvedValue({
                balanceAfter: new Decimal("5.0"),
            });
            prisma.ledgerEntry.aggregate.mockResolvedValue({
                _sum: { holdAmount: new Decimal("1.5") },
            });

            const balance = await service.getBalance(1, "BTC");

            expect(balance.total).toEqual(new Decimal("5.0"));
            expect(balance.held).toEqual(new Decimal("1.5"));
            expect(balance.available).toEqual(new Decimal("3.5"));
        });

        it("should uppercase the currency for lookups", async () => {
            prisma.ledgerEntry.findFirst.mockResolvedValue(null);
            prisma.ledgerEntry.aggregate.mockResolvedValue({ _sum: { holdAmount: null } });

            await service.getBalance(1, "btc");

            expect(prisma.ledgerEntry.findFirst).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ currency: "BTC" }),
                }),
            );
        });
    });

    // ── getHistory ───────────────────────────────────────────

    describe("getHistory", () => {
        it("should fetch entries with pagination", async () => {
            prisma.ledgerEntry.findMany.mockResolvedValue([]);

            await service.getHistory(1, "BTC", 10, 0);

            expect(prisma.ledgerEntry.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { userId: 1, currency: "BTC" },
                    take: 10,
                    skip: 0,
                }),
            );
        });
    });

    // ── getAllBalances ────────────────────────────────────────

    describe("getAllBalances", () => {
        it("should return balances for all currencies a user holds", async () => {
            prisma.ledgerEntry.findMany.mockResolvedValue([
                { currency: "BTC" },
                { currency: "ETH" },
            ]);
            // called twice — once per currency
            prisma.ledgerEntry.findFirst
                .mockResolvedValueOnce({ balanceAfter: new Decimal("1.0") })
                .mockResolvedValueOnce({ balanceAfter: new Decimal("10.0") });
            prisma.ledgerEntry.aggregate.mockResolvedValue({ _sum: { holdAmount: null } });

            const balances = await service.getAllBalances(1);

            expect(balances.size).toBe(2);
            expect(balances.get("BTC")?.total).toEqual(new Decimal("1.0"));
            expect(balances.get("ETH")?.total).toEqual(new Decimal("10.0"));
        });
    });

    // ── Static constants ─────────────────────────────────────

    describe("constants", () => {
        it("should define PLATFORM_USER_ID as 0", () => {
            expect(LedgerService.PLATFORM_USER_ID).toBe(0);
        });

        it("should define NETWORK_FEE_USER_ID as -1", () => {
            expect(LedgerService.NETWORK_FEE_USER_ID).toBe(-1);
        });
    });
});
