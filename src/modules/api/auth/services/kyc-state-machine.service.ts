// @ts-nocheck — Remove after running `npx prisma migrate dev && npx prisma generate`
// New KycVerification columns (version, isActive, escalatedAt, escalatedById) are in schema
// but not yet in the generated Prisma client.

/**
 * KYC State Machine Service
 *
 * Centralised transition enforcer for all KYC verification status changes.
 * Every service that mutates a verification status MUST go through this service
 * so that:
 *   1. Only legal transitions are allowed.
 *   2. A KycVerification audit record is always created / updated.
 *   3. Re-submissions bump the version and deactivate previous records.
 *   4. Optimistic locking prevents concurrent overwrites.
 */

import { Injectable, Logger, ConflictException, BadRequestException } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { KycVerificationType, KycStatus } from "@prisma/client";

// ───────────────────── Types ─────────────────────

export type KycTransitionStatus =
    | "PENDING"
    | "APPROVED"
    | "REJECTED"
    | "ESCALATED"
    | "VERIFIED"          // alias used by callers → mapped to APPROVED
    | "DECLINED"          // alias used by callers → mapped to REJECTED
    | "RESUBMITTED";

export interface TransitionMetadata {
    reviewerId?: number;
    reviewNote?: string;
    documentUrl?: string;
    /** Pass current version for optimistic-lock check (admin decisions). */
    expectedVersion?: number;
}

export interface TransitionResult {
    kycVerificationId: number;
    status: KycStatus;
    version: number;
    isActive: boolean;
}

// ───────────────────── Legal transitions ─────────────────────

/**
 * Map of `fromStatus → Set<toStatus>`.
 * `null` means "no prior record exists" (first submission).
 */
const LEGAL_TRANSITIONS: Record<string, Set<string>> = {
    // First-time submission
    "null":       new Set(["PENDING", "APPROVED"]),
    // Pending → decision
    "PENDING":    new Set(["APPROVED", "REJECTED", "ESCALATED"]),
    // Rejected → user resubmits
    "REJECTED":   new Set(["RESUBMITTED"]),
    // Resubmitted → new pending review
    "RESUBMITTED": new Set(["PENDING"]),
    // Escalated → final decision
    "ESCALATED":  new Set(["APPROVED", "REJECTED"]),
};

// ───────────────────── Service ─────────────────────

@Injectable()
export class KycStateMachineService {
    private readonly logger = new Logger(KycStateMachineService.name);

    constructor(private readonly prisma: PrismaService) {}

    /**
     * Execute a verified state transition and persist the audit record.
     *
     * @returns The created / updated KycVerification record summary.
     * @throws BadRequestException on illegal transition.
     * @throws ConflictException on optimistic-lock failure.
     */
    async transition(
        userId: number,
        verificationType: KycVerificationType,
        toStatusRaw: KycTransitionStatus,
        metadata: TransitionMetadata = {},
    ): Promise<TransitionResult> {
        const toStatus = this.normaliseStatus(toStatusRaw);

        // Fetch the current *active* record for this user + type
        const current = await this.prisma.kycVerification.findFirst({
            where: { userId, verificationType, isActive: true },
            orderBy: { version: "desc" },
        });

        const fromKey = current ? current.status : "null";

        // ── Idempotency: already in desired state ──
        if (current && current.status === toStatus) {
            this.logger.log(
                `[KYC-SM] No-op: user ${userId} ${verificationType} already ${toStatus}`,
            );
            return {
                kycVerificationId: current.id,
                status: current.status,
                version: current.version,
                isActive: current.isActive,
            };
        }

        // ── Validate transition legality ──
        const allowed = LEGAL_TRANSITIONS[fromKey];
        if (!allowed || !allowed.has(toStatus)) {
            throw new BadRequestException(
                `Illegal KYC transition for ${verificationType}: ${fromKey} → ${toStatus}`,
            );
        }

        // ── Optimistic locking (for admin decision paths) ──
        if (
            metadata.expectedVersion !== undefined &&
            current &&
            current.version !== metadata.expectedVersion
        ) {
            throw new ConflictException(
                `KYC record for user ${userId} ${verificationType} was modified concurrently ` +
                `(expected version ${metadata.expectedVersion}, found ${current.version})`,

            );
        }

        // ── Resubmission: deactivate old record, bump version ──
        if (toStatus === "RESUBMITTED" as any) {
            return this.handleResubmission(userId, verificationType, current!, metadata);
        }

        // ── Create or update ──
        if (!current) {
            return this.createRecord(userId, verificationType, toStatus, metadata);
        }

        return this.updateRecord(current.id, toStatus, metadata);
    }

    // ───────── Internal helpers ─────────

    private async createRecord(
        userId: number,
        verificationType: KycVerificationType,
        status: KycStatus,
        meta: TransitionMetadata,
    ): Promise<TransitionResult> {
        const record = await this.prisma.kycVerification.create({
            data: {
                userId,
                verificationType,
                status,
                version: 1,
                isActive: true,
                reviewerId: meta.reviewerId,
                reviewNote: meta.reviewNote,
                documentUrl: meta.documentUrl,
                reviewedAt: this.isDecisionStatus(status) ? new Date() : undefined,
                escalatedAt: status === KycStatus.ESCALATED ? new Date() : undefined,
                escalatedById: status === KycStatus.ESCALATED ? meta.reviewerId : undefined,
            } as any,
        });

        this.logger.log(
            `[KYC-SM] Created: user ${userId} ${verificationType} → ${status} (v${record.version})`,
        );

        return {
            kycVerificationId: record.id,
            status: record.status,
            version: record.version,
            isActive: record.isActive,
        };
    }

    private async updateRecord(
        recordId: number,
        status: KycStatus,
        meta: TransitionMetadata,
    ): Promise<TransitionResult> {
        const record = await this.prisma.kycVerification.update({
            where: { id: recordId },
            data: {
                status,
                reviewerId: meta.reviewerId ?? undefined,
                reviewNote: meta.reviewNote ?? undefined,
                documentUrl: meta.documentUrl ?? undefined,
                reviewedAt: this.isDecisionStatus(status) ? new Date() : undefined,
                escalatedAt: status === KycStatus.ESCALATED ? new Date() : undefined,
                escalatedById: status === KycStatus.ESCALATED ? meta.reviewerId : undefined,
            } as any,
        });

        this.logger.log(
            `[KYC-SM] Updated: record ${recordId} → ${status} (v${record.version})`,
        );

        return {
            kycVerificationId: record.id,
            status: record.status,
            version: record.version,
            isActive: record.isActive,
        };
    }

    private async handleResubmission(
        userId: number,
        verificationType: KycVerificationType,
        previousRecord: { id: number; version: number },
        meta: TransitionMetadata,
    ): Promise<TransitionResult> {
        const newVersion = previousRecord.version + 1;

        // Deactivate old record
        await this.prisma.kycVerification.update({
            where: { id: previousRecord.id },
            data: { isActive: false } as any,
        });

        // Create new PENDING record at next version
        const record = await this.prisma.kycVerification.create({
            data: {
                userId,
                verificationType,
                status: KycStatus.PENDING,
                version: newVersion,
                isActive: true,
                reviewNote: meta.reviewNote,
                documentUrl: meta.documentUrl,
            } as any,
        });

        this.logger.log(
            `[KYC-SM] Resubmission: user ${userId} ${verificationType} v${previousRecord.version} → v${newVersion} (PENDING)`,
        );

        return {
            kycVerificationId: record.id,
            status: record.status,
            version: record.version,
            isActive: record.isActive,
        };
    }

    /**
     * Map caller-friendly aliases to KycStatus enum values.
     */
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
                // Resubmission creates a new PENDING record (handled specially)
                return "RESUBMITTED" as any;
            default:
                throw new BadRequestException(`Unknown KYC status: ${raw}`);
        }
    }

    private isDecisionStatus(status: KycStatus): boolean {
        return [KycStatus.APPROVED, KycStatus.REJECTED, KycStatus.ESCALATED].includes(status);
    }
}
