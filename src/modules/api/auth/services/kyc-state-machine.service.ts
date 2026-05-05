/**
 * KYC State Machine Service
 *
 * Centralised transition enforcer for KYC verification status changes.
 * Migrated flows now persist mutable state on KycStageAttempt and immutable
 * audit history on KycAttemptEvent.
 */

import { Injectable, Logger, ConflictException, BadRequestException } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import {
    KycActorType,
    KycAttemptEventType,
    KycAttemptStatus,
    KycDecisionMode,
    KycJourneyType,
    KycMethod,
    KycProviderName,
    KycProviderStatus,
    KycStage,
    KycStatus,
    Prisma,
} from "@prisma/client";

const stageManagedVerificationTypes = [
    "BVN",
    "NIN",
    "DOCUMENT",
    "ADDRESS",
    "INCOME",
    "BUSINESS_DOCUMENT",
] as const;

export type StageManagedVerificationType = (typeof stageManagedVerificationTypes)[number];

export type KycTransitionStatus =
    | "PENDING"
    | "APPROVED"
    | "REJECTED"
    | "ESCALATED"
    | "VERIFIED"
    | "DECLINED"
    | "RESUBMITTED";

export interface TransitionMetadata {
    reviewerId?: number;
    reviewNote?: string;
    documentUrl?: string;
    providerRef?: string | null;
    providerRawResponse?: Record<string, any> | null;
    expectedVersion?: number;
}

export interface TransitionResult {
    attemptId: number;
    status: KycStatus;
    version: number;
    isActive: boolean;
}

const stageManagedVerificationTypeSet = new Set<string>(stageManagedVerificationTypes);

const LEGAL_TRANSITIONS: Record<string, Set<string>> = {
    "null": new Set(["PENDING", "APPROVED"]),
    PENDING: new Set(["APPROVED", "REJECTED", "ESCALATED"]),
    REJECTED: new Set(["RESUBMITTED"]),
    RESUBMITTED: new Set(["PENDING"]),
    ESCALATED: new Set(["APPROVED", "REJECTED"]),
};

const currentAttemptSelect = Prisma.validator<Prisma.KycStageAttemptSelect>()({
    id: true,
    userId: true,
    journeyType: true,
    stage: true,
    method: true,
    attemptNo: true,
    isCurrent: true,
    status: true,
    providerRef: true,
    reviewerId: true,
    reviewNote: true,
    reviewedAt: true,
    escalatedAt: true,
    version: true,
});

type CurrentAttemptRecord = Prisma.KycStageAttemptGetPayload<{
    select: typeof currentAttemptSelect;
}>;

@Injectable()
export class KycStateMachineService {
    private readonly logger = new Logger(KycStateMachineService.name);

    constructor(private readonly prisma: PrismaService) {}

    async transition(
        userId: number,
        verificationTypeRaw: string,
        toStatusRaw: KycTransitionStatus,
        metadata: TransitionMetadata = {},
    ): Promise<TransitionResult> {
        const verificationType = this.normalizeVerificationType(verificationTypeRaw);
        const toStatus = this.normaliseStatus(toStatusRaw);
        const current = await this.findCurrentAttempt(userId, verificationType);
        const currentStatus = current ? this.mapAttemptStatusToKycStatus(current.status) : null;
        const fromKey = currentStatus ?? "null";

        if (currentStatus === toStatus) {
            this.logger.log(
                `[KYC-SM] No-op: user ${userId} ${verificationType} already ${toStatus}`,
            );
            return this.buildTransitionResult(current);
        }

        const allowed = LEGAL_TRANSITIONS[fromKey];
        if (!allowed?.has(toStatus)) {
            throw new BadRequestException(
                `Illegal KYC transition for ${verificationType}: ${fromKey} → ${toStatus}`,
            );
        }

        if (
            metadata.expectedVersion !== undefined
            && current
            && current.version !== metadata.expectedVersion
        ) {
            throw new ConflictException(
                `KYC record for user ${userId} ${verificationType} was modified concurrently ` +
                `(expected version ${metadata.expectedVersion}, found ${current.version})`,
            );
        }

        if (toStatus === ("RESUBMITTED" as any)) {
            if (!current) {
                throw new BadRequestException(
                    `Illegal KYC transition for ${verificationType}: ${fromKey} → ${toStatus}`,
                );
            }

            return this.handleResubmission(userId, verificationType, current, metadata);
        }

        if (!current) {
            return this.createAttempt(userId, verificationType, toStatus, metadata);
        }

        return this.updateAttempt(current, verificationType, toStatus, metadata);
    }

    private async findCurrentAttempt(
        userId: number,
        verificationType: StageManagedVerificationType,
    ): Promise<CurrentAttemptRecord | null> {
        const stage = this.mapVerificationTypeToStage(verificationType);
        const journeyType = this.mapVerificationTypeToJourneyType(verificationType);
        const method = this.mapVerificationTypeToMethod(verificationType);

        return await this.prisma.kycStageAttempt.findFirst({
            where: {
                userId,
                journeyType,
                stage,
                method,
                isCurrent: true,
            },
            orderBy: [{ attemptNo: "desc" }, { id: "desc" }],
            select: currentAttemptSelect,
        });
    }

    private async createAttempt(
        userId: number,
        verificationType: StageManagedVerificationType,
        status: KycStatus,
        meta: TransitionMetadata,
    ): Promise<TransitionResult> {
        const stage = this.mapVerificationTypeToStage(verificationType);
        const journeyType = this.mapVerificationTypeToJourneyType(verificationType);
        const method = this.mapVerificationTypeToMethod(verificationType);
        const nextAttemptAggregate = await this.prisma.kycStageAttempt.aggregate({
            where: {
                userId,
                stage,
            },
            _max: { attemptNo: true },
        });
        const attemptStatus = this.mapKycStatusToAttemptStatus(status);
        const now = new Date();
        const reviewedAt = this.isDecisionStatus(status) ? now : null;
        const escalatedAt = status === KycStatus.ESCALATED ? now : null;

        const attempt = await this.prisma.kycStageAttempt.create({
            data: {
                userId,
                journeyType,
                stage,
                method,
                attemptNo: (nextAttemptAggregate._max.attemptNo ?? 0) + 1,
                isCurrent: true,
                status: attemptStatus,
                providerName: this.resolveProviderName(meta),
                providerStatus: this.mapKycStatusToProviderStatus(status),
                decisionMode: KycDecisionMode.MANUAL,
                providerRef: meta.providerRef ?? null,
                reasonMessage: status === KycStatus.APPROVED ? null : meta.reviewNote ?? null,
                reasonDetails: status === KycStatus.APPROVED || !meta.reviewNote
                    ? Prisma.DbNull
                    : { reviewNote: meta.reviewNote },
                evidenceSummary: this.buildEvidenceSummary(meta),
                reviewerId: meta.reviewerId ?? null,
                reviewNote: meta.reviewNote ?? null,
                reviewedAt,
                escalatedAt,
            } as Prisma.KycStageAttemptUncheckedCreateInput,
            select: currentAttemptSelect,
        });

        await this.appendAttemptEvent(attempt, verificationType, this.mapKycStatusToEventType(status), meta);

        this.logger.log(
            `[KYC-SM] Created: user ${userId} ${verificationType} → ${status} (v${attempt.version})`,
        );

        return this.buildTransitionResult(attempt);
    }

    private async updateAttempt(
        current: CurrentAttemptRecord,
        verificationType: StageManagedVerificationType,
        status: KycStatus,
        meta: TransitionMetadata,
    ): Promise<TransitionResult> {
        const now = new Date();
        const updatedAttempt = await this.prisma.kycStageAttempt.update({
            where: { id: current.id },
            data: {
                status: this.mapKycStatusToAttemptStatus(status),
                providerName: this.resolveProviderName(meta),
                providerStatus: this.mapKycStatusToProviderStatus(status),
                decisionMode: KycDecisionMode.MANUAL,
                providerRef: meta.providerRef ?? undefined,
                reviewerId: meta.reviewerId ?? undefined,
                reviewNote: meta.reviewNote ?? undefined,
                reasonMessage: status === KycStatus.APPROVED ? null : meta.reviewNote ?? null,
                reasonDetails: status === KycStatus.APPROVED || !meta.reviewNote
                    ? Prisma.DbNull
                    : { reviewNote: meta.reviewNote },
                evidenceSummary: this.buildEvidenceSummary(meta),
                reviewedAt: this.isDecisionStatus(status) ? now : undefined,
                escalatedAt: status === KycStatus.ESCALATED ? now : null,
            } as Prisma.KycStageAttemptUncheckedUpdateInput,
            select: currentAttemptSelect,
        });

        await this.appendAttemptEvent(updatedAttempt, verificationType, this.mapKycStatusToEventType(status), meta);

        this.logger.log(
            `[KYC-SM] Updated: attempt ${current.id} → ${status} (v${updatedAttempt.version})`,
        );

        return this.buildTransitionResult(updatedAttempt);
    }

    private async handleResubmission(
        userId: number,
        verificationType: StageManagedVerificationType,
        previousAttempt: CurrentAttemptRecord,
        meta: TransitionMetadata,
    ): Promise<TransitionResult> {
        const nextAttemptAggregate = await this.prisma.kycStageAttempt.aggregate({
            where: {
                userId,
                stage: previousAttempt.stage,
            },
            _max: { attemptNo: true },
        });
        const newVersion = previousAttempt.version + 1;

        await this.prisma.kycStageAttempt.update({
            where: { id: previousAttempt.id },
            data: { isCurrent: false } as Prisma.KycStageAttemptUncheckedUpdateInput,
        });

        const attempt = await this.prisma.kycStageAttempt.create({
            data: {
                userId,
                journeyType: previousAttempt.journeyType,
                stage: previousAttempt.stage,
                method: previousAttempt.method,
                attemptNo: (nextAttemptAggregate._max.attemptNo ?? previousAttempt.attemptNo) + 1,
                isCurrent: true,
                status: KycAttemptStatus.SUBMITTED,
                providerName: this.resolveProviderName(meta),
                providerStatus: KycProviderStatus.NOT_REQUESTED,
                decisionMode: KycDecisionMode.MANUAL,
                providerRef: meta.providerRef ?? null,
                reasonMessage: meta.reviewNote ?? null,
                reasonDetails: meta.reviewNote ? { reviewNote: meta.reviewNote } : Prisma.DbNull,
                evidenceSummary: this.buildEvidenceSummary(meta),
                reviewNote: meta.reviewNote ?? null,
                version: newVersion,
            } as Prisma.KycStageAttemptUncheckedCreateInput,
            select: currentAttemptSelect,
        });

        await this.appendAttemptEvent(attempt, verificationType, KycAttemptEventType.RESUBMITTED, meta);

        this.logger.log(
            `[KYC-SM] Resubmission: user ${userId} ${verificationType} v${previousAttempt.version} → v${newVersion} (PENDING)`,
        );

        return this.buildTransitionResult(attempt);
    }

    private async appendAttemptEvent(
        attempt: CurrentAttemptRecord,
        verificationType: StageManagedVerificationType,
        eventType: KycAttemptEventType,
        meta: TransitionMetadata,
    ): Promise<void> {
        await (this.prisma as any).kycAttemptEvent.create({
            data: {
                attemptId: attempt.id,
                userId: attempt.userId,
                journeyType: attempt.journeyType,
                stage: attempt.stage,
                eventType,
                actorType: meta.reviewerId ? KycActorType.ADMIN : KycActorType.SYSTEM,
                actorId: meta.reviewerId ?? null,
                providerName: this.resolveProviderName(meta),
                providerStatus: this.mapKycStatusToProviderStatus(this.mapAttemptStatusToKycStatus(attempt.status)),
                providerRef: meta.providerRef ?? undefined,
                note: meta.reviewNote ?? undefined,
                payload: this.buildTransitionEventPayload(verificationType, eventType, meta),
            },
        });
    }

    private buildTransitionResult(attempt: CurrentAttemptRecord): TransitionResult {
        return {
            attemptId: attempt.id,
            status: this.mapAttemptStatusToKycStatus(attempt.status),
            version: attempt.version,
            isActive: attempt.isCurrent,
        };
    }

    private buildTransitionEventPayload(
        verificationType: StageManagedVerificationType,
        eventType: KycAttemptEventType,
        meta: TransitionMetadata,
    ): Prisma.InputJsonValue | undefined {
        if (!meta.reviewNote && !meta.documentUrl && !meta.providerRef && !meta.providerRawResponse && meta.expectedVersion === undefined) {
            return undefined;
        }

        return {
            source: "KYC_STATE_MACHINE",
            verificationType,
            eventType,
            reviewNote: meta.reviewNote ?? null,
            documentUrl: meta.documentUrl ?? null,
            providerRef: meta.providerRef ?? null,
            providerRawResponse: meta.providerRawResponse ?? null,
            expectedVersion: meta.expectedVersion ?? null,
        } as Prisma.InputJsonValue;
    }

    private buildEvidenceSummary(meta: TransitionMetadata): Prisma.InputJsonValue | undefined {
        if (!meta.documentUrl) {
            return undefined;
        }

        return { documentUrl: meta.documentUrl } as Prisma.InputJsonValue;
    }

    private normalizeVerificationType(verificationType: string): StageManagedVerificationType {
        if (stageManagedVerificationTypeSet.has(verificationType)) {
            return verificationType as StageManagedVerificationType;
        }

        throw new BadRequestException(`Unsupported stage-managed verification type: ${verificationType}`);
    }

    private mapVerificationTypeToStage(verificationType: StageManagedVerificationType): KycStage {
        switch (verificationType) {
            case "BVN":
            case "NIN":
                return KycStage.GOVERNMENT_ID;
            case "DOCUMENT":
                return KycStage.IDENTITY_DOCUMENT;
            case "ADDRESS":
                return KycStage.ADDRESS;
            case "INCOME":
                return KycStage.INCOME;
            case "BUSINESS_DOCUMENT":
                return KycStage.BUSINESS_DOCUMENT;
        }
    }

    private mapVerificationTypeToJourneyType(verificationType: StageManagedVerificationType): KycJourneyType {
        return verificationType === "BUSINESS_DOCUMENT"
            ? KycJourneyType.BUSINESS
            : KycJourneyType.INDIVIDUAL;
    }

    private mapVerificationTypeToMethod(verificationType: StageManagedVerificationType): KycMethod {
        switch (verificationType) {
            case "BVN":
                return KycMethod.BVN;
            case "NIN":
                return KycMethod.NIN;
            case "DOCUMENT":
            case "ADDRESS":
            case "INCOME":
            case "BUSINESS_DOCUMENT":
                return KycMethod.OTHER;
        }
    }

    private mapAttemptStatusToKycStatus(status: KycAttemptStatus): KycStatus {
        switch (status) {
            case KycAttemptStatus.APPROVED:
                return KycStatus.APPROVED;
            case KycAttemptStatus.REJECTED:
            case KycAttemptStatus.EXPIRED:
                return KycStatus.REJECTED;
            case KycAttemptStatus.ESCALATED:
                return KycStatus.ESCALATED;
            case KycAttemptStatus.DRAFT:
            case KycAttemptStatus.SUBMITTED:
            case KycAttemptStatus.PENDING_REVIEW:
            default:
                return KycStatus.PENDING;
        }
    }

    private mapKycStatusToAttemptStatus(status: KycStatus): KycAttemptStatus {
        switch (status) {
            case KycStatus.APPROVED:
                return KycAttemptStatus.APPROVED;
            case KycStatus.REJECTED:
                return KycAttemptStatus.REJECTED;
            case KycStatus.ESCALATED:
                return KycAttemptStatus.ESCALATED;
            case KycStatus.PENDING:
            default:
                return KycAttemptStatus.SUBMITTED;
        }
    }

    private mapKycStatusToProviderStatus(status: KycStatus): KycProviderStatus {
        switch (status) {
            case KycStatus.APPROVED:
                return KycProviderStatus.PASSED;
            case KycStatus.REJECTED:
                return KycProviderStatus.FAILED;
            case KycStatus.ESCALATED:
                return KycProviderStatus.INCONCLUSIVE;
            case KycStatus.PENDING:
            default:
                return KycProviderStatus.NOT_REQUESTED;
        }
    }

    private mapKycStatusToEventType(status: KycStatus): KycAttemptEventType {
        switch (status) {
            case KycStatus.APPROVED:
                return KycAttemptEventType.APPROVED;
            case KycStatus.REJECTED:
                return KycAttemptEventType.REJECTED;
            case KycStatus.ESCALATED:
                return KycAttemptEventType.ESCALATED;
            case KycStatus.PENDING:
            default:
                return KycAttemptEventType.SUBMITTED;
        }
    }

    private resolveProviderName(meta: TransitionMetadata): KycProviderName {
        return meta.providerRef || meta.providerRawResponse
            ? KycProviderName.DOJAH
            : KycProviderName.NONE;
    }

    private normaliseStatus(raw: KycTransitionStatus): KycStatus {
        switch (raw) {
            case "VERIFIED":
            case "APPROVED":
                return KycStatus.APPROVED;
            case "DECLINED":
            case "REJECTED":
                return KycStatus.REJECTED;
            case "ESCALATED":
                return KycStatus.ESCALATED;
            case "PENDING":
                return KycStatus.PENDING;
            case "RESUBMITTED":
                return "RESUBMITTED" as any;
            default:
                throw new BadRequestException(`Unknown KYC status: ${raw}`);
        }
    }

    private isDecisionStatus(status: KycStatus): boolean {
        return ([KycStatus.APPROVED, KycStatus.REJECTED, KycStatus.ESCALATED] as KycStatus[]).includes(status);
    }
}