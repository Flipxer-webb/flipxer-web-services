import { Test, TestingModule } from "@nestjs/testing";
import { HttpStatus } from "@nestjs/common";
import { IdentityIdType, Prisma } from "@prisma/client";

jest.mock("@/config", () => ({
    DB_TRANSACTION_TIMEOUT: 10000,
    IDENTITY_DEDUP_ENABLED: true,
}));

import { IdentityResolutionService } from "../identity-resolution.service";
import { PrismaService } from "@/modules/core/prisma/services";
import { VerificationGenericException } from "../../errors";

type TxMock = {
    identityIdentifier: {
        findUnique: jest.Mock;
        create: jest.Mock;
    };
    identitySubject: {
        create: jest.Mock;
    };
    user: {
        findUniqueOrThrow: jest.Mock;
        update: jest.Mock;
        findFirst: jest.Mock;
    };
};

function buildTxMock(): TxMock {
    return {
        identityIdentifier: {
            findUnique: jest.fn(),
            create: jest.fn(),
        },
        identitySubject: {
            create: jest.fn(),
        },
        user: {
            findUniqueOrThrow: jest.fn(),
            update: jest.fn(),
            findFirst: jest.fn(),
        },
    };
}

describe("IdentityResolutionService", () => {
    let service: IdentityResolutionService;
    let prisma: {
        $transaction: jest.Mock;
        user: {
            findUnique: jest.Mock;
        };
    };
    let tx: TxMock;

    beforeEach(async () => {
        tx = buildTxMock();

        prisma = {
            $transaction: jest.fn(async (callback: (txMock: TxMock) => unknown) => {
                return await callback(tx);
            }),
            user: {
                findUnique: jest.fn(),
            },
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                IdentityResolutionService,
                { provide: PrismaService, useValue: prisma },
            ],
        }).compile();

        service = module.get<IdentityResolutionService>(IdentityResolutionService);
    });

    it("hashIdentifier normalizes input before hashing", () => {
        const hashA = service.hashIdentifier("  AbC123  ");
        const hashB = service.hashIdentifier("abc123");

        expect(hashA).toBe(hashB);
        expect(hashA).toHaveLength(64);
    });

    it("maskIdentifier keeps first and last 2 characters", () => {
        expect(service.maskIdentifier("22345678901")).toBe("22*******01");
        expect(service.maskIdentifier("1234")).toBe("1234");
    });

    it("throws conflict when identifier belongs to a different user", async () => {
        tx.identityIdentifier.findUnique.mockResolvedValue({
            subject: { id: 3, user: { id: 99 } },
        });

        await expect(
            service.resolveOrCreate(IdentityIdType.BVN, "22345678901", 1),
        ).rejects.toMatchObject({
            status: HttpStatus.CONFLICT,
        });
    });

    it("returns idempotent response when identifier is linked to same user", async () => {
        tx.identityIdentifier.findUnique.mockResolvedValue({
            subject: { id: 7, user: { id: 1 } },
        });

        await expect(
            service.resolveOrCreate(IdentityIdType.BVN, "22345678901", 1),
        ).resolves.toEqual({ subjectId: 7, isNew: false });

        expect(tx.user.update).not.toHaveBeenCalled();
        expect(tx.identityIdentifier.create).not.toHaveBeenCalled();
    });

    it("links orphan subject to user when identifier exists without linked user", async () => {
        tx.identityIdentifier.findUnique.mockResolvedValue({
            subject: { id: 11, user: null },
        });
        tx.user.update.mockResolvedValue({});

        await expect(
            service.resolveOrCreate(IdentityIdType.NIN, "12345678901", 5),
        ).resolves.toEqual({ subjectId: 11, isNew: false });

        expect(tx.user.update).toHaveBeenCalledWith({
            where: { id: 5 },
            data: { identitySubjectId: 11 },
        });
    });

    it("adds identifier to existing subject when user already has a subject", async () => {
        tx.identityIdentifier.findUnique.mockResolvedValue(null);
        tx.user.findUniqueOrThrow.mockResolvedValue({ identitySubjectId: 21 });
        tx.identityIdentifier.create.mockResolvedValue({});
        tx.user.findFirst.mockResolvedValue(null);

        await expect(
            service.resolveOrCreate(IdentityIdType.BVN, "22345678901", 2),
        ).resolves.toEqual({ subjectId: 21, isNew: false });

        expect(tx.identitySubject.create).not.toHaveBeenCalled();
        expect(tx.identityIdentifier.create).toHaveBeenCalled();
    });

    it("creates new subject and identifier when user has no subject", async () => {
        tx.identityIdentifier.findUnique.mockResolvedValue(null);
        tx.user.findUniqueOrThrow.mockResolvedValue({ identitySubjectId: null });
        tx.identitySubject.create.mockResolvedValue({ id: 42 });
        tx.user.update.mockResolvedValue({});
        tx.identityIdentifier.create.mockResolvedValue({});
        tx.user.findFirst.mockResolvedValue(null);

        await expect(
            service.resolveOrCreate(IdentityIdType.NIN, "12345678901", 8),
        ).resolves.toEqual({ subjectId: 42, isNew: true });

        expect(tx.identitySubject.create).toHaveBeenCalled();
        expect(tx.user.update).toHaveBeenCalledWith({
            where: { id: 8 },
            data: { identitySubjectId: 42 },
        });
    });

    it("throws conflict on cross-check subject collision", async () => {
        tx.identityIdentifier.findUnique.mockResolvedValue(null);
        tx.user.findUniqueOrThrow.mockResolvedValue({ identitySubjectId: 21 });
        tx.identityIdentifier.create.mockResolvedValue({});
        tx.user.findFirst.mockResolvedValue({ id: 77 });

        await expect(
            service.resolveOrCreate(IdentityIdType.BVN, "22345678901", 2),
        ).rejects.toBeInstanceOf(VerificationGenericException);
    });

    it("maps Prisma P2002 race condition to conflict exception", async () => {
        const p2002 = Object.create(
            Prisma.PrismaClientKnownRequestError.prototype,
        ) as Prisma.PrismaClientKnownRequestError;
        (p2002 as any).code = "P2002";
        (p2002 as any).message = "Unique violation";

        prisma.$transaction.mockRejectedValueOnce(p2002);

        await expect(
            service.resolveOrCreate(IdentityIdType.BVN, "22345678901", 1),
        ).rejects.toMatchObject({
            status: HttpStatus.CONFLICT,
        });
    });

    it("retries once on Prisma P2034 serialization conflict and then succeeds", async () => {
        const p2034 = Object.create(
            Prisma.PrismaClientKnownRequestError.prototype,
        ) as Prisma.PrismaClientKnownRequestError;
        (p2034 as any).code = "P2034";
        (p2034 as any).message = "Serialization conflict";

        tx.identityIdentifier.findUnique.mockResolvedValue({
            subject: { id: 15, user: { id: 1 } },
        });

        prisma.$transaction
            .mockRejectedValueOnce(p2034)
            .mockImplementationOnce(async (callback: (txMock: TxMock) => unknown) => callback(tx));

        await expect(
            service.resolveOrCreate(IdentityIdType.BVN, "22345678901", 1),
        ).resolves.toEqual({ subjectId: 15, isNew: false });

        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it("throws last P2034 error after retry exhaustion", async () => {
        const p2034 = Object.create(
            Prisma.PrismaClientKnownRequestError.prototype,
        ) as Prisma.PrismaClientKnownRequestError;
        (p2034 as any).code = "P2034";
        (p2034 as any).message = "Serialization conflict";

        prisma.$transaction.mockRejectedValue(p2034);

        await expect(
            service.resolveOrCreate(IdentityIdType.NIN, "12345678901", 9),
        ).rejects.toBe(p2034);

        expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    });

    it("rethrows unknown non-Error transaction failures", async () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;

        prisma.$transaction.mockRejectedValueOnce(circular as unknown);

        await expect(
            service.resolveOrCreate(IdentityIdType.BVN, "22345678901", 2),
        ).rejects.toBe(circular);
    });

    it("rethrows JSON-stringifiable non-Error transaction failures", async () => {
        const plainPayload = { reason: "provider-timeout", retryable: false };

        prisma.$transaction.mockRejectedValueOnce(plainPayload as unknown);

        await expect(
            service.resolveOrCreate(IdentityIdType.NIN, "12345678901", 3),
        ).rejects.toBe(plainPayload);
    });

    it("getSubjectForUser returns null when user has no subject", async () => {
        prisma.user.findUnique.mockResolvedValue({ identitySubject: null });

        await expect(service.getSubjectForUser(123)).resolves.toBeNull();
    });

    it("getSubjectForUser returns identifiers when subject exists", async () => {
        prisma.user.findUnique.mockResolvedValue({
            identitySubject: {
                id: 5,
                identifiers: [{ type: IdentityIdType.BVN, maskedValue: "22*******01" }],
            },
        });

        await expect(service.getSubjectForUser(123)).resolves.toEqual({
            subjectId: 5,
            identifiers: [{ type: IdentityIdType.BVN, maskedValue: "22*******01" }],
        });
    });
});
