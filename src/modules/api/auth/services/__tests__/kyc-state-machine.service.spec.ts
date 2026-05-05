import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { KycStateMachineService } from "../kyc-state-machine.service";
import { PrismaService } from "@/modules/core/prisma/services";
import { KycAttemptStatus, KycStatus } from "@prisma/client";

const mockPrismaService = {
    kycStageAttempt: {
        aggregate: jest.fn(),
        create: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
    },
    kycAttemptEvent: {
        create: jest.fn(),
    },
};

const buildAttempt = (overrides: Record<string, unknown> = {}) => ({
    id: 1,
    userId: 1,
    journeyType: "INDIVIDUAL",
    stage: "GOVERNMENT_ID",
    method: "BVN",
    attemptNo: 1,
    isCurrent: true,
    status: KycAttemptStatus.SUBMITTED,
    providerRef: null,
    reviewerId: null,
    reviewNote: null,
    reviewedAt: null,
    escalatedAt: null,
    version: 1,
    ...overrides,
});

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
        jest.resetAllMocks();
        mockPrismaService.kycStageAttempt.aggregate.mockResolvedValue({ _max: { attemptNo: null } });
        mockPrismaService.kycAttemptEvent.create.mockResolvedValue({ id: 100 });
    });

    describe("first-time submission", () => {
        it("allows transition from null to PENDING", async () => {
            mockPrismaService.kycStageAttempt.findFirst.mockResolvedValue(null);
            mockPrismaService.kycStageAttempt.create.mockResolvedValue(buildAttempt({
                status: KycAttemptStatus.SUBMITTED,
            }));

            const result = await service.transition(1, "BVN", "PENDING");

            expect(result.status).toBe(KycStatus.PENDING);
            expect(result.version).toBe(1);
            expect(result.isActive).toBe(true);
            expect(mockPrismaService.kycStageAttempt.create).toHaveBeenCalled();
            expect(mockPrismaService.kycAttemptEvent.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        attemptId: 1,
                        eventType: "SUBMITTED",
                    }),
                }),
            );
        });

        it("allows transition from null to APPROVED (auto-approve)", async () => {
            mockPrismaService.kycStageAttempt.findFirst.mockResolvedValue(null);
            mockPrismaService.kycStageAttempt.create.mockResolvedValue(buildAttempt({
                id: 2,
                status: KycAttemptStatus.APPROVED,
                reviewedAt: new Date(),
            }));

            const result = await service.transition(1, "BVN", "APPROVED");

            expect(result.status).toBe(KycStatus.APPROVED);
        });
    });

    describe("status alias mapping", () => {
        it("maps VERIFIED to APPROVED", async () => {
            mockPrismaService.kycStageAttempt.findFirst.mockResolvedValue(null);
            mockPrismaService.kycStageAttempt.create.mockResolvedValue(buildAttempt({
                id: 3,
                status: KycAttemptStatus.APPROVED,
                reviewedAt: new Date(),
            }));

            const result = await service.transition(1, "BVN", "VERIFIED");

            expect(result.status).toBe(KycStatus.APPROVED);
        });

        it("maps DECLINED to REJECTED", async () => {
            mockPrismaService.kycStageAttempt.findFirst.mockResolvedValue(buildAttempt({
                status: KycAttemptStatus.PENDING_REVIEW,
            }));
            mockPrismaService.kycStageAttempt.update.mockResolvedValue(buildAttempt({
                status: KycAttemptStatus.REJECTED,
                reviewedAt: new Date(),
            }));

            const result = await service.transition(1, "BVN", "DECLINED");

            expect(result.status).toBe(KycStatus.REJECTED);
        });
    });

    describe("illegal transitions", () => {
        it("rejects APPROVED → PENDING", async () => {
            mockPrismaService.kycStageAttempt.findFirst.mockResolvedValue(buildAttempt({
                status: KycAttemptStatus.APPROVED,
                reviewedAt: new Date(),
            }));

            await expect(service.transition(1, "BVN", "PENDING")).rejects.toThrow(BadRequestException);
        });

        it("rejects null → REJECTED (cannot reject before submission)", async () => {
            mockPrismaService.kycStageAttempt.findFirst.mockResolvedValue(null);

            await expect(service.transition(1, "BVN", "REJECTED")).rejects.toThrow(BadRequestException);
        });

        it("rejects unknown status", async () => {
            mockPrismaService.kycStageAttempt.findFirst.mockResolvedValue(null);

            await expect(service.transition(1, "BVN", "INVALID_STATUS" as any)).rejects.toThrow(BadRequestException);
        });
    });

    describe("idempotency", () => {
        it("returns existing record if already in target state", async () => {
            mockPrismaService.kycStageAttempt.findFirst.mockResolvedValue(buildAttempt({
                status: KycAttemptStatus.APPROVED,
                reviewedAt: new Date(),
            }));

            const result = await service.transition(1, "BVN", "APPROVED");

            expect(result.attemptId).toBe(1);
            expect(result.status).toBe(KycStatus.APPROVED);
            expect(mockPrismaService.kycStageAttempt.create).not.toHaveBeenCalled();
            expect(mockPrismaService.kycStageAttempt.update).not.toHaveBeenCalled();
        });
    });

    describe("optimistic locking", () => {
        it("throws ConflictException on version mismatch", async () => {
            mockPrismaService.kycStageAttempt.findFirst.mockResolvedValue(buildAttempt({
                status: KycAttemptStatus.PENDING_REVIEW,
                version: 3,
            }));

            await expect(service.transition(1, "BVN", "APPROVED", { expectedVersion: 2 })).rejects.toThrow(ConflictException);
        });

        it("proceeds when version matches", async () => {
            mockPrismaService.kycStageAttempt.findFirst.mockResolvedValue(buildAttempt({
                status: KycAttemptStatus.PENDING_REVIEW,
                version: 2,
            }));
            mockPrismaService.kycStageAttempt.update.mockResolvedValue(buildAttempt({
                status: KycAttemptStatus.APPROVED,
                reviewedAt: new Date(),
                version: 2,
            }));

            const result = await service.transition(1, "BVN", "APPROVED", { expectedVersion: 2 });

            expect(result.status).toBe(KycStatus.APPROVED);
        });
    });

    describe("resubmission flow", () => {
        it("deactivates old attempt and creates new pending attempt", async () => {
            mockPrismaService.kycStageAttempt.findFirst.mockResolvedValue(buildAttempt({
                stage: "IDENTITY_DOCUMENT",
                method: "OTHER",
                status: KycAttemptStatus.REJECTED,
                reviewedAt: new Date(),
                version: 2,
            }));
            mockPrismaService.kycStageAttempt.aggregate.mockResolvedValue({ _max: { attemptNo: 1 } });
            mockPrismaService.kycStageAttempt.update.mockResolvedValue({ id: 1 });
            mockPrismaService.kycStageAttempt.create.mockResolvedValue(buildAttempt({
                id: 2,
                stage: "IDENTITY_DOCUMENT",
                method: "OTHER",
                attemptNo: 2,
                status: KycAttemptStatus.SUBMITTED,
                version: 3,
            }));

            const result = await service.transition(1, "DOCUMENT", "RESUBMITTED");

            expect(result.version).toBe(3);
            expect(result.status).toBe(KycStatus.PENDING);
            expect(result.isActive).toBe(true);
            expect(mockPrismaService.kycStageAttempt.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 1 },
                    data: expect.objectContaining({ isCurrent: false }),
                }),
            );
            expect(mockPrismaService.kycAttemptEvent.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        attemptId: 2,
                        eventType: "RESUBMITTED",
                    }),
                }),
            );
        });
    });

    describe("PENDING → decision transitions", () => {
        beforeEach(() => {
            mockPrismaService.kycStageAttempt.findFirst.mockResolvedValue(buildAttempt({
                status: KycAttemptStatus.PENDING_REVIEW,
            }));
        });

        it("allows PENDING → APPROVED", async () => {
            mockPrismaService.kycStageAttempt.update.mockResolvedValue(buildAttempt({
                status: KycAttemptStatus.APPROVED,
                reviewerId: 100,
                reviewNote: "Looks good",
                reviewedAt: new Date(),
            }));

            const result = await service.transition(1, "BVN", "APPROVED", {
                reviewerId: 100,
                reviewNote: "Looks good",
            });

            expect(result.status).toBe(KycStatus.APPROVED);
        });

        it("allows PENDING → REJECTED", async () => {
            mockPrismaService.kycStageAttempt.update.mockResolvedValue(buildAttempt({
                status: KycAttemptStatus.REJECTED,
                reviewedAt: new Date(),
            }));

            const result = await service.transition(1, "BVN", "REJECTED");

            expect(result.status).toBe(KycStatus.REJECTED);
        });

        it("allows PENDING → ESCALATED", async () => {
            mockPrismaService.kycStageAttempt.update.mockResolvedValue(buildAttempt({
                status: KycAttemptStatus.ESCALATED,
                reviewedAt: new Date(),
                escalatedAt: new Date(),
            }));

            const result = await service.transition(1, "BVN", "ESCALATED");

            expect(result.status).toBe(KycStatus.ESCALATED);
        });
    });
});