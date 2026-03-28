import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { KycStateMachineService } from "../kyc-state-machine.service";
import { PrismaService } from "@/modules/core/prisma/services";
import { KycStatus, KycVerificationType } from "@prisma/client";

const mockPrismaService = {
    kycVerification: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
    },
};

describe("KycStateMachineService", () => {
    let service: KycStateMachineService;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                KycStateMachineService,
                { provide: PrismaService, useValue: mockPrismaService },
            ],
        }).compile();

        service = module.get(KycStateMachineService);
        jest.clearAllMocks();
    });

    describe("first-time submission", () => {
        it("allows transition from null to PENDING", async () => {
            mockPrismaService.kycVerification.findFirst.mockResolvedValue(null);
            mockPrismaService.kycVerification.create.mockResolvedValue({
                id: 1,
                status: KycStatus.PENDING,
                version: 1,
                isActive: true,
            });

            const result = await service.transition(
                1,
                KycVerificationType.BVN,
                "PENDING",
            );

            expect(result.status).toBe(KycStatus.PENDING);
            expect(result.version).toBe(1);
            expect(result.isActive).toBe(true);
            expect(mockPrismaService.kycVerification.create).toHaveBeenCalled();
        });

        it("allows transition from null to APPROVED (auto-approve)", async () => {
            mockPrismaService.kycVerification.findFirst.mockResolvedValue(null);
            mockPrismaService.kycVerification.create.mockResolvedValue({
                id: 2,
                status: KycStatus.APPROVED,
                version: 1,
                isActive: true,
            });

            const result = await service.transition(
                1,
                KycVerificationType.BVN,
                "APPROVED",
            );

            expect(result.status).toBe(KycStatus.APPROVED);
        });
    });

    describe("status alias mapping", () => {
        it("maps VERIFIED to APPROVED", async () => {
            mockPrismaService.kycVerification.findFirst.mockResolvedValue(null);
            mockPrismaService.kycVerification.create.mockResolvedValue({
                id: 3,
                status: KycStatus.APPROVED,
                version: 1,
                isActive: true,
            });

            const result = await service.transition(
                1,
                KycVerificationType.BVN,
                "VERIFIED",
            );

            expect(result.status).toBe(KycStatus.APPROVED);
        });

        it("maps DECLINED to REJECTED", async () => {
            mockPrismaService.kycVerification.findFirst.mockResolvedValue({
                id: 1,
                status: KycStatus.PENDING,
                version: 1,
                isActive: true,
            });
            mockPrismaService.kycVerification.update.mockResolvedValue({
                id: 1,
                status: KycStatus.REJECTED,
                version: 1,
                isActive: true,
            });

            const result = await service.transition(
                1,
                KycVerificationType.BVN,
                "DECLINED",
            );

            expect(result.status).toBe(KycStatus.REJECTED);
        });
    });

    describe("illegal transitions", () => {
        it("rejects APPROVED → PENDING", async () => {
            mockPrismaService.kycVerification.findFirst.mockResolvedValue({
                id: 1,
                status: KycStatus.APPROVED,
                version: 1,
                isActive: true,
            });

            await expect(
                service.transition(1, KycVerificationType.BVN, "PENDING"),
            ).rejects.toThrow(BadRequestException);
        });

        it("rejects null → REJECTED (cannot reject before submission)", async () => {
            mockPrismaService.kycVerification.findFirst.mockResolvedValue(null);

            await expect(
                service.transition(1, KycVerificationType.BVN, "REJECTED"),
            ).rejects.toThrow(BadRequestException);
        });

        it("rejects unknown status", async () => {
            mockPrismaService.kycVerification.findFirst.mockResolvedValue(null);

            await expect(
                service.transition(
                    1,
                    KycVerificationType.BVN,
                    "INVALID_STATUS" as any,
                ),
            ).rejects.toThrow(BadRequestException);
        });
    });

    describe("idempotency", () => {
        it("returns existing record if already in target state", async () => {
            mockPrismaService.kycVerification.findFirst.mockResolvedValue({
                id: 1,
                status: KycStatus.APPROVED,
                version: 1,
                isActive: true,
            });

            const result = await service.transition(
                1,
                KycVerificationType.BVN,
                "APPROVED",
            );

            expect(result.kycVerificationId).toBe(1);
            expect(result.status).toBe(KycStatus.APPROVED);
            expect(mockPrismaService.kycVerification.create).not.toHaveBeenCalled();
            expect(mockPrismaService.kycVerification.update).not.toHaveBeenCalled();
        });
    });

    describe("optimistic locking", () => {
        it("throws ConflictException on version mismatch", async () => {
            mockPrismaService.kycVerification.findFirst.mockResolvedValue({
                id: 1,
                status: KycStatus.PENDING,
                version: 3,
                isActive: true,
            });

            await expect(
                service.transition(
                    1,
                    KycVerificationType.BVN,
                    "APPROVED",
                    { expectedVersion: 2 },
                ),
            ).rejects.toThrow(ConflictException);
        });

        it("proceeds when version matches", async () => {
            mockPrismaService.kycVerification.findFirst.mockResolvedValue({
                id: 1,
                status: KycStatus.PENDING,
                version: 2,
                isActive: true,
            });
            mockPrismaService.kycVerification.update.mockResolvedValue({
                id: 1,
                status: KycStatus.APPROVED,
                version: 2,
                isActive: true,
            });

            const result = await service.transition(
                1,
                KycVerificationType.BVN,
                "APPROVED",
                { expectedVersion: 2 },
            );

            expect(result.status).toBe(KycStatus.APPROVED);
        });
    });

    describe("resubmission flow", () => {
        it("deactivates old record and creates new PENDING record", async () => {
            mockPrismaService.kycVerification.findFirst.mockResolvedValue({
                id: 1,
                status: KycStatus.REJECTED,
                version: 2,
                isActive: true,
            });
            mockPrismaService.kycVerification.update.mockResolvedValue({
                id: 1,
                status: KycStatus.REJECTED,
                version: 2,
                isActive: false,
            });
            mockPrismaService.kycVerification.create.mockResolvedValue({
                id: 2,
                status: KycStatus.PENDING,
                version: 3,
                isActive: true,
            });

            const result = await service.transition(
                1,
                KycVerificationType.DOCUMENT,
                "RESUBMITTED",
            );

            expect(result.version).toBe(3);
            expect(result.status).toBe(KycStatus.PENDING);
            expect(result.isActive).toBe(true);
            expect(mockPrismaService.kycVerification.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 1 },
                    data: expect.objectContaining({ isActive: false }),
                }),
            );
        });
    });

    describe("PENDING → decision transitions", () => {
        beforeEach(() => {
            mockPrismaService.kycVerification.findFirst.mockResolvedValue({
                id: 1,
                status: KycStatus.PENDING,
                version: 1,
                isActive: true,
            });
        });

        it("allows PENDING → APPROVED", async () => {
            mockPrismaService.kycVerification.update.mockResolvedValue({
                id: 1,
                status: KycStatus.APPROVED,
                version: 1,
                isActive: true,
            });

            const result = await service.transition(
                1,
                KycVerificationType.BVN,
                "APPROVED",
                { reviewerId: 100, reviewNote: "Looks good" },
            );

            expect(result.status).toBe(KycStatus.APPROVED);
        });

        it("allows PENDING → REJECTED", async () => {
            mockPrismaService.kycVerification.update.mockResolvedValue({
                id: 1,
                status: KycStatus.REJECTED,
                version: 1,
                isActive: true,
            });

            const result = await service.transition(
                1,
                KycVerificationType.BVN,
                "REJECTED",
            );

            expect(result.status).toBe(KycStatus.REJECTED);
        });

        it("allows PENDING → ESCALATED", async () => {
            mockPrismaService.kycVerification.update.mockResolvedValue({
                id: 1,
                status: KycStatus.ESCALATED,
                version: 1,
                isActive: true,
            });

            const result = await service.transition(
                1,
                KycVerificationType.BVN,
                "ESCALATED",
            );

            expect(result.status).toBe(KycStatus.ESCALATED);
        });
    });
});
