import { DocumentVerificationStatus } from "@prisma/client";

export type ManagedIndividualKycStage = "GOVERNMENT_ID" | "IDENTITY_DOCUMENT" | "ADDRESS" | "INCOME";
export type ManagedGovernmentMethod = "BVN" | "NIN";

export interface IndividualStageAttemptLike {
    stage: string;
    method?: string | null;
    status?: string | null;
    isCurrent?: boolean;
}

export interface IndividualVerificationSnapshot {
    bvnVerified: boolean;
    ninVerified: boolean;
    documentVerified: boolean;
    addressVerified: boolean;
    incomeVerified: boolean;
    documentStatus: DocumentVerificationStatus | null;
    addressStatus: DocumentVerificationStatus | null;
    incomeStatus: DocumentVerificationStatus | null;
}

export function getCurrentIndividualStageAttempt<T extends IndividualStageAttemptLike>(
    attempts: T[] | null | undefined,
    stage: ManagedIndividualKycStage,
    method?: ManagedGovernmentMethod | null,
): T | null {
    if (!Array.isArray(attempts)) {
        return null;
    }

    return attempts.find((attempt) => {
        if (attempt?.stage !== stage || attempt?.isCurrent === false) {
            return false;
        }

        if (!method) {
            return true;
        }

        return attempt.method === method;
    }) ?? null;
}

export function isIndividualAttemptApproved(status?: string | null): boolean {
    return status === "APPROVED";
}

export function isIndividualAttemptPending(status?: string | null): boolean {
    return ["SUBMITTED", "PENDING_REVIEW", "ESCALATED"].includes(status ?? "");
}

export function isIndividualAttemptRejected(status?: string | null): boolean {
    return status === "REJECTED" || status === "EXPIRED";
}

export function getCurrentGovernmentMethod(params: {
    kycStageAttempts?: IndividualStageAttemptLike[] | null;
    bvn?: string | null;
    nin?: string | null;
}): ManagedGovernmentMethod | null {
    const stageAttempt = getCurrentIndividualStageAttempt(params.kycStageAttempts, "GOVERNMENT_ID");

    if (stageAttempt?.method === "BVN" || stageAttempt?.method === "NIN") {
        return stageAttempt.method;
    }

    if (params.bvn) {
        return "BVN";
    }

    if (params.nin) {
        return "NIN";
    }

    return null;
}

export function mapAttemptStatusToDocumentStatus(
    status?: string | null,
): DocumentVerificationStatus | null {
    if (status === "APPROVED") {
        return DocumentVerificationStatus.VERIFIED;
    }

    if (isIndividualAttemptPending(status)) {
        return DocumentVerificationStatus.PENDING;
    }

    if (isIndividualAttemptRejected(status)) {
        return DocumentVerificationStatus.DECLINED;
    }

    return null;
}

export function buildIndividualVerificationSnapshot(params: {
    userType?: string | null;
    kycStageAttempts?: IndividualStageAttemptLike[] | null;
    bvn?: string | null;
    nin?: string | null;
}): IndividualVerificationSnapshot {
    const governmentMethod = getCurrentGovernmentMethod(params);
    const governmentAttempt = getCurrentIndividualStageAttempt(params.kycStageAttempts, "GOVERNMENT_ID", governmentMethod);
    const documentAttempt = getCurrentIndividualStageAttempt(params.kycStageAttempts, "IDENTITY_DOCUMENT");
    const addressAttempt = getCurrentIndividualStageAttempt(params.kycStageAttempts, "ADDRESS");
    const incomeAttempt = getCurrentIndividualStageAttempt(params.kycStageAttempts, "INCOME");

    const isGovernmentApproved = isIndividualAttemptApproved(governmentAttempt?.status);
    const documentStatus = mapAttemptStatusToDocumentStatus(documentAttempt?.status);
    const addressStatus = mapAttemptStatusToDocumentStatus(addressAttempt?.status);
    const incomeStatus = mapAttemptStatusToDocumentStatus(incomeAttempt?.status);

    return {
        bvnVerified: governmentMethod === "BVN" && isGovernmentApproved,
        ninVerified: governmentMethod === "NIN" && isGovernmentApproved,
        documentVerified: documentStatus === DocumentVerificationStatus.VERIFIED,
        addressVerified: addressStatus === DocumentVerificationStatus.VERIFIED,
        incomeVerified: incomeStatus === DocumentVerificationStatus.VERIFIED,
        documentStatus,
        addressStatus,
        incomeStatus,
    };
}