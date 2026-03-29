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

    // ── lock helpers ─────────────────────────────────────────

    describe("lock helpers", () => {
        it("runWithLock should call distributed lock with uppercase currency key", async () => {
            const result = await service.runWithLock(7, "btc", async () => "ok");

            expect(result).toBe("ok");
            expect(lockService.withLock).toHaveBeenCalledWith(
                "ledger:7:BTC",
                expect.any(Function),
                expect.objectContaining({ ttlMs: 15000, maxWaitMs: 20000, strict: true }),
            );
        });

        it("runWithLock should throw when lock acquisition fails", async () => {
            lockService.withLock.mockRejectedValueOnce(new Error("lock timeout"));

            await expect(
                service.runWithLock(7, "btc", async () => "noop"),
            ).rejects.toThrow("lock timeout");
        });

        it("runWithMultiUserLocks should sort lock keys and delegate to withLocks", async () => {
            const withLocksSpy = jest
                .spyOn(service as any, "withLocks")
                .mockResolvedValueOnce("done");

            const result = await service.runWithMultiUserLocks([9, 2, 5], "eth", async () => "x");

            expect(result).toBe("done");
            expect(withLocksSpy).toHaveBeenCalledWith(
                ["ledger:2:ETH", "ledger:5:ETH", "ledger:9:ETH"],
                expect.any(Function),
            );
        });

        it("runWithMultiUserLocks should throw when delegated lock flow fails", async () => {
            jest
                .spyOn(service as any, "withLocks")
                .mockRejectedValueOnce(new Error("multi-lock failed"));

            await expect(
                service.runWithMultiUserLocks([2, 3], "usdt", async () => "x"),
            ).rejects.toThrow("multi-lock failed");
        });
    });

    // ── pairedCredit / pairedCreditInTransaction ──────────

    describe("pairedCredit", () => {
        const opts = {
            userId: 7,
            currency: "BTC",
            type: LedgerType.DEPOSIT,
            amount: "0.5",
            reference: "paired-credit-001",
            description: "paired credit",
        };

        it("should create user credit and platform debit entries", async () => {
            tx.ledgerEntry.findUnique.mockResolvedValue(null);
            tx.ledgerEntry.findFirst
                .mockResolvedValueOnce({ balanceAfter: new Decimal("1.0") })
                .mockResolvedValueOnce({ balanceAfter: new Decimal("10.0") });
            tx.ledgerEntry.create
                .mockResolvedValueOnce({ id: "u-credit-1", reference: opts.reference })
                .mockResolvedValueOnce({ id: "p-debit-1", reference: `platform:${opts.reference}` });

            const result = await service.pairedCredit(opts);

            expect(result.success).toBe(true);
            expect(result.userEntry?.id).toBe("u-credit-1");
            expect(result.platformEntry?.reference).toBe(`platform:${opts.reference}`);
            expect(lockService.withLock).toHaveBeenNthCalledWith(
                1,
                "ledger:0:BTC",
                expect.any(Function),
                expect.objectContaining({ ttlMs: 20000 }),
            );
            expect(lockService.withLock).toHaveBeenNthCalledWith(
                2,
                "ledger:7:BTC",
                expect.any(Function),
                expect.objectContaining({ ttlMs: 20000 }),
            );
        });

        it("should skip platform entry when createPlatformEntry is false", async () => {
            tx.ledgerEntry.findUnique.mockResolvedValue(null);
            tx.ledgerEntry.findFirst.mockResolvedValueOnce({ balanceAfter: new Decimal("1.0") });
            tx.ledgerEntry.create.mockResolvedValueOnce({ id: "u-credit-2", reference: opts.reference });

            const result = await service.pairedCredit({ ...opts, createPlatformEntry: false });

            expect(result.success).toBe(true);
            expect(result.platformEntry).toBeNull();
            expect(tx.ledgerEntry.create).toHaveBeenCalledTimes(1);
            expect(lockService.withLock).toHaveBeenCalledTimes(1);
            expect(lockService.withLock).toHaveBeenCalledWith(
                "ledger:7:BTC",
                expect.any(Function),
                expect.objectContaining({ ttlMs: 20000 }),
            );
        });

        it("should return existing user entry when reference already exists", async () => {
            tx.ledgerEntry.findUnique.mockResolvedValue({
                id: "existing-user-entry",
                balanceAfter: new Decimal("2.5"),
                reference: opts.reference,
            });

            const result = await service.pairedCredit(opts);

            expect(result.success).toBe(true);
            expect(result.userEntry?.id).toBe("existing-user-entry");
            expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
        });

        it("should reject platform user id", async () => {
            const result = await service.pairedCredit({
                ...opts,
                userId: LedgerService.PLATFORM_USER_ID,
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain("Cannot use pairedCredit for platform user");
            expect(lockService.withLock).not.toHaveBeenCalled();
        });
    });

    describe("pairedCreditInTransaction", () => {
        const opts = {
            userId: 9,
            currency: "USDT",
            type: LedgerType.DEPOSIT,
            amount: "1.25",
            reference: "paired-credit-tx-001",
        };

        it("should return error for non-positive amount", async () => {
            const result = await service.pairedCreditInTransaction(tx as any, {
                ...opts,
                amount: "0",
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain("Amount must be positive");
        });

        it("should catch transaction-client failures", async () => {
            tx.ledgerEntry.findUnique.mockRejectedValueOnce(new Error("tx-failure"));

            const result = await service.pairedCreditInTransaction(tx as any, opts);

            expect(result.success).toBe(false);
            expect(result.error).toContain("tx-failure");
        });
    });

    // ── pairedDebit ────────────────────────────────────────

    describe("pairedDebit", () => {
        const opts = {
            userId: 11,
            currency: "BTC",
            type: LedgerType.WITHDRAWAL,
            amount: "0.8",
            reference: "paired-debit-001",
            description: "paired debit",
            createPlatformEntry: true,
        };

        it("should create user debit, platform credit, and fee entries", async () => {
            tx.ledgerEntry.findFirst
                .mockResolvedValueOnce({ balanceAfter: new Decimal("5.0") })
                .mockResolvedValueOnce({ balanceAfter: new Decimal("20.0") })
                .mockResolvedValueOnce({ balanceAfter: new Decimal("2.0") });
            tx.ledgerEntry.aggregate.mockResolvedValue({ _sum: { holdAmount: null } });
            tx.ledgerEntry.findUnique.mockResolvedValue(null);
            tx.ledgerEntry.create
                .mockResolvedValueOnce({ id: "user-debit-1" })
                .mockResolvedValueOnce({ id: "platform-credit-1" })
                .mockResolvedValueOnce({ id: "user-fee-1" })
                .mockResolvedValueOnce({ id: "fee-account-1" });

            const result = await service.pairedDebit({ ...opts, networkFee: "0.05" as any });

            expect(result.success).toBe(true);
            expect(result.userEntry?.id).toBe("user-debit-1");
            expect(result.platformEntry?.id).toBe("platform-credit-1");
            expect(tx.ledgerEntry.create).toHaveBeenCalledTimes(4);
            expect(lockService.withLock).toHaveBeenNthCalledWith(
                1,
                "ledger:-1:BTC",
                expect.any(Function),
                expect.objectContaining({ ttlMs: 20000 }),
            );
            expect(lockService.withLock).toHaveBeenNthCalledWith(
                2,
                "ledger:0:BTC",
                expect.any(Function),
                expect.objectContaining({ ttlMs: 20000 }),
            );
            expect(lockService.withLock).toHaveBeenNthCalledWith(
                3,
                "ledger:11:BTC",
                expect.any(Function),
                expect.objectContaining({ ttlMs: 20000 }),
            );
        });

        it("should fail when available balance is insufficient", async () => {
            tx.ledgerEntry.findFirst.mockResolvedValueOnce({ balanceAfter: new Decimal("0.2") });
            tx.ledgerEntry.aggregate.mockResolvedValue({ _sum: { holdAmount: null } });

            const result = await service.pairedDebit(opts);

            expect(result.success).toBe(false);
            expect(result.error).toContain("Insufficient balance");
            expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
        });

        it("should be idempotent when debit reference already exists", async () => {
            tx.ledgerEntry.findFirst.mockResolvedValueOnce({ balanceAfter: new Decimal("3.0") });
            tx.ledgerEntry.aggregate.mockResolvedValue({ _sum: { holdAmount: null } });
            tx.ledgerEntry.findUnique.mockResolvedValue({
                id: "existing-paired-debit",
                balanceAfter: new Decimal("2.2"),
            });

            const result = await service.pairedDebit(opts);

            expect(result.success).toBe(true);
            expect(result.userEntry?.id).toBe("existing-paired-debit");
            expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
        });

        it("should reject platform user id", async () => {
            const result = await service.pairedDebit({
                ...opts,
                userId: LedgerService.PLATFORM_USER_ID,
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain("Cannot use pairedDebit for platform user");
            expect(lockService.withLock).not.toHaveBeenCalled();
        });

        it("should return error when multi-lock acquisition fails", async () => {
            jest
                .spyOn(service as any, "withLocks")
                .mockRejectedValueOnce(new Error("paired-debit-lock-failed"));

            const result = await service.pairedDebit(opts);

            expect(result.success).toBe(false);
            expect(result.error).toContain("paired-debit-lock-failed");
            expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
        });
    });

    // ── releaseHoldWithPlatformEntry ───────────────────────

    describe("releaseHoldWithPlatformEntry", () => {
        const holdEntry = {
            id: "hold-platform-1",
            userId: 17,
            currency: "BTC",
            balanceAfter: new Decimal("1.5"),
            holdAmount: new Decimal("0.4"),
            status: EntryStatus.HOLD,
            type: LedgerType.HOLD,
            reference: "hold-platform-ref-1",
            tradeGroupId: "tg-1",
            description: "held",
        };

        it("should settle hold and create platform + fee entries", async () => {
            prisma.ledgerEntry.findFirst.mockResolvedValue(holdEntry);
            tx.ledgerEntry.findUnique.mockResolvedValue(holdEntry);
            tx.ledgerEntry.update.mockResolvedValue({ ...holdEntry, status: EntryStatus.SETTLED });
            tx.ledgerEntry.findFirst
                .mockResolvedValueOnce({ balanceAfter: new Decimal("10.0") })
                .mockResolvedValueOnce({ balanceAfter: new Decimal("1.0") });
            tx.ledgerEntry.create
                .mockResolvedValueOnce({ id: "platform-credit-2" })
                .mockResolvedValueOnce({ id: "fee-credit-2" });

            const result = await service.releaseHoldWithPlatformEntry({
                holdReference: holdEntry.reference,
                settle: true,
                createPlatformEntry: true,
                networkFee: "0.05" as any,
                description: "settle hold",
            });

            expect(result.success).toBe(true);
            expect(result.userEntry?.id).toBe("hold-platform-1");
            expect(result.platformEntry?.id).toBe("platform-credit-2");
            expect(tx.ledgerEntry.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: "hold-platform-1" },
                    data: expect.objectContaining({ status: EntryStatus.SETTLED }),
                }),
            );
            expect(tx.ledgerEntry.create).toHaveBeenCalledTimes(2);
        });

        it("should cancel hold on refund path without creating platform entries", async () => {
            prisma.ledgerEntry.findFirst.mockResolvedValue(holdEntry);
            tx.ledgerEntry.findUnique.mockResolvedValue(holdEntry);
            tx.ledgerEntry.update.mockResolvedValue({ ...holdEntry, status: EntryStatus.CANCELLED });

            const result = await service.releaseHoldWithPlatformEntry({
                holdReference: holdEntry.reference,
                settle: false,
                createPlatformEntry: false,
            });

            expect(result.success).toBe(true);
            expect(result.platformEntry).toBeNull();
            expect(tx.ledgerEntry.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ status: EntryStatus.CANCELLED }),
                }),
            );
            expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
        });

        it("should fail when hold reference is not found", async () => {
            prisma.ledgerEntry.findFirst.mockResolvedValue(null);

            const result = await service.releaseHoldWithPlatformEntry({
                holdReference: "missing-hold",
                settle: true,
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain("Hold entry not found");
        });

        it("should fail when hold is no longer valid in transaction", async () => {
            prisma.ledgerEntry.findFirst.mockResolvedValue(holdEntry);
            tx.ledgerEntry.findUnique.mockResolvedValue({ ...holdEntry, status: EntryStatus.SETTLED });

            const result = await service.releaseHoldWithPlatformEntry({
                holdReference: holdEntry.reference,
                settle: true,
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain("already released");
        });

        it("should return error when release-hold lock flow fails", async () => {
            prisma.ledgerEntry.findFirst.mockResolvedValue(holdEntry);
            jest
                .spyOn(service as any, "withLocks")
                .mockRejectedValueOnce(new Error("release-hold-lock-failed"));

            const result = await service.releaseHoldWithPlatformEntry({
                holdReference: holdEntry.reference,
                settle: true,
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain("release-hold-lock-failed");
        });
    });

    // ── transfer ────────────────────────────────────────────

    describe("transfer", () => {
        it("should transfer between users when source has sufficient balance", async () => {
            tx.ledgerEntry.findUnique.mockResolvedValue(null);
            tx.ledgerEntry.findFirst
                .mockResolvedValueOnce({ balanceAfter: new Decimal("2.0") })
                .mockResolvedValueOnce({ balanceAfter: new Decimal("1.2") });
            tx.ledgerEntry.aggregate.mockResolvedValue({ _sum: { holdAmount: null } });
            tx.ledgerEntry.create
                .mockResolvedValueOnce({ id: "transfer-debit-1" })
                .mockResolvedValueOnce({ id: "transfer-credit-1" });

            const result = await service.transfer(
                3,
                8,
                "btc",
                "0.5",
                LedgerType.SEND,
                "transfer-001",
            );

            expect(result.success).toBe(true);
            expect(result.entryId).toBe("transfer-debit-1");
            expect(lockService.withLock).toHaveBeenNthCalledWith(
                1,
                "ledger:3:BTC",
                expect.any(Function),
                expect.objectContaining({ ttlMs: 45000 }),
            );
            expect(lockService.withLock).toHaveBeenNthCalledWith(
                2,
                "ledger:8:BTC",
                expect.any(Function),
                expect.objectContaining({ ttlMs: 15000 }),
            );
        });

        it("should be idempotent when transfer debit reference exists", async () => {
            tx.ledgerEntry.findUnique.mockResolvedValue({
                id: "existing-transfer",
                balanceAfter: new Decimal("1.0"),
            });

            const result = await service.transfer(
                3,
                8,
                "BTC",
                "0.5",
                LedgerType.SEND,
                "transfer-002",
            );

            expect(result.success).toBe(true);
            expect(result.entryId).toBe("existing-transfer");
            expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
        });

        it("should fail when non-platform source has insufficient balance", async () => {
            tx.ledgerEntry.findUnique.mockResolvedValue(null);
            tx.ledgerEntry.findFirst.mockResolvedValueOnce({ balanceAfter: new Decimal("0.1") });
            tx.ledgerEntry.aggregate.mockResolvedValue({ _sum: { holdAmount: null } });

            const result = await service.transfer(
                4,
                9,
                "BTC",
                "0.5",
                LedgerType.SEND,
                "transfer-003",
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain("Insufficient balance");
        });

        it("should reject non-positive transfer amount", async () => {
            const result = await service.transfer(
                4,
                9,
                "BTC",
                "0",
                LedgerType.SEND,
                "transfer-004",
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain("must be positive");
            expect(lockService.withLock).not.toHaveBeenCalled();
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
