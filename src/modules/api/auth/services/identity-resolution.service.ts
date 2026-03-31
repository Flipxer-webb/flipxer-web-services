import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { Prisma, IdentityIdType } from "@prisma/client";
import * as crypto from "node:crypto";
import { PrismaService } from "@/modules/core/prisma/services";
import { VerificationGenericException } from "../errors";
import { DB_TRANSACTION_TIMEOUT, IDENTITY_DEDUP_ENABLED } from "@/config";

export interface IdentityResolutionResult {
    subjectId: number;
    isNew: boolean;
}

export interface BiographicData {
    firstName: string;
    lastName: string;
    dateOfBirth: string; // raw DOB string from provider (any format)
}

@Injectable()
export class IdentityResolutionService {
    private readonly logger = new Logger(IdentityResolutionService.name);

    constructor(private readonly prisma: PrismaService) {}

    /**
     * Hash a raw identifier (BVN/NIN) using SHA-256 for storage lookup.
     * Strips whitespace and lowercases before hashing.
     */
    hashIdentifier(rawValue: string): string {
        const normalised = rawValue.trim().toLowerCase();
        return crypto.createHash("sha256").update(normalised).digest("hex");
    }

    /**
     * Generate a masked version of an identifier for admin display.
     * e.g. "22345678901" → "22*****01"
     */
    maskIdentifier(rawValue: string): string {
        if (rawValue.length <= 4) return rawValue;
        const first2 = rawValue.slice(0, 2);
        const last2 = rawValue.slice(-2);
        const masked = "*".repeat(rawValue.length - 4);
        return `${first2}${masked}${last2}`;
    }

    /**
     * Normalize and hash biographic data (first name + last name + DOB) for
     * cross-ID-type duplicate detection.
     *
     * Normalization rules:
     * - Trim and uppercase names
     * - Sort [firstName, lastName] alphabetically to handle swapped order
     * - Parse DOB to YYYY-MM-DD regardless of input format
     * - Final string: "SORTEDNAME1|SORTEDNAME2|YYYY-MM-DD"
     */
    hashBiographic(data: BiographicData): string {
        const normFirst = data.firstName.trim().toUpperCase();
        const normLast = data.lastName.trim().toUpperCase();
        const sortedNames = [normFirst, normLast].sort((a, b) => a.localeCompare(b));
        const normDob = this.normalizeDateOfBirth(data.dateOfBirth);
        const composite = `${sortedNames[0]}|${sortedNames[1]}|${normDob}`;
        return crypto.createHash("sha256").update(composite).digest("hex");
    }

    /**
     * Normalize various DOB formats to YYYY-MM-DD.
     * Handles: "1990-01-15", "15-01-1990", "01/15/1990", "15/01/1990", "1990/01/15"
     */
    private normalizeDateOfBirth(raw: string): string {
        const cleaned = raw.trim();

        // Try ISO format first (YYYY-MM-DD or YYYY/MM/DD)
        const isoRegex = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/;
        const isoMatch = isoRegex.exec(cleaned);
        if (isoMatch) {
            return `${isoMatch[1]}-${isoMatch[2].padStart(2, "0")}-${isoMatch[3].padStart(2, "0")}`;
        }

        // DD-MM-YYYY or DD/MM/YYYY (common Nigerian format)
        const dmyRegex = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/;
        const dmyMatch = dmyRegex.exec(cleaned);
        if (dmyMatch) {
            return `${dmyMatch[3]}-${dmyMatch[2].padStart(2, "0")}-${dmyMatch[1].padStart(2, "0")}`;
        }

        // Fallback: use as-is (will still work for comparison if both providers return same format)
        return cleaned;
    }

    private static readonly MAX_RETRIES = 3;

    private formatUnknownError(error: unknown): string {
        if (error instanceof Error) return error.message;
        try {
            return JSON.stringify(error);
        } catch {
            return "Unserializable error value";
        }
    }

    /**
     * Core identity resolution within a SERIALIZABLE transaction.
     *
     * 1. Hash the raw value
     * 2. Look up IdentityIdentifier by (type, valueHash)
     * 3. If found → get IdentitySubject
     *    - If subject linked to a different user → throw DUPLICATE
     *    - If linked to same user → idempotent return
     * 4. If not found → create IdentitySubject + IdentityIdentifier + link user
     * 5. Return { subjectId, isNew }
     */
    async resolveOrCreate(
        type: IdentityIdType,
        rawValue: string,
        userId: number,
        biographic?: BiographicData,
    ): Promise<IdentityResolutionResult> {
        const valueHash = this.hashIdentifier(rawValue);
        const maskedValue = this.maskIdentifier(rawValue);

        this.logger.log(
            `[IDENTITY] Resolving ${type} for user ${userId} (hash=${valueHash.slice(0, 8)}...)`,
        );

        // Feature flag: skip graph resolution but DB unique constraints still enforced
        if (!IDENTITY_DEDUP_ENABLED) {
            this.logger.log(`[IDENTITY] Feature flag disabled — skipping graph resolution for user ${userId}`);
            return { subjectId: 0, isNew: false };
        }

        let lastError: unknown;
        for (let attempt = 1; attempt <= IdentityResolutionService.MAX_RETRIES; attempt++) {
            try {
                return await this.executeResolutionTransaction(tx => this.resolveOrCreateInner(tx, type, valueHash, maskedValue, userId, biographic));
            } catch (error) {
                const shouldRetry = this.handleResolutionError(type, userId, attempt, error);
                if (shouldRetry) {
                    lastError = error;
                    continue;
                }
            }
        }

        this.logger.error(
            `[IDENTITY] All ${IdentityResolutionService.MAX_RETRIES} retries exhausted for ${type}, user ${userId}`,
        );
        throw lastError;
    }

    private handleResolutionError(
        type: IdentityIdType,
        userId: number,
        attempt: number,
        error: unknown,
    ): boolean {
        // Re-throw our own exceptions immediately (no retry)
        if (error instanceof VerificationGenericException) {
            throw error;
        }

        // P2002 = unique constraint violation (race condition with another request)
        if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002"
        ) {
            this.logger.warn(
                `[IDENTITY][P2002] Unique constraint violation for ${type}, user ${userId}`,
            );
            throw new VerificationGenericException(
                `This ${type} is already linked to another account. If this is yours, please contact support.`,
                HttpStatus.CONFLICT,
            );
        }

        // Serialization failure (PostgreSQL 40001) - retry
        if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2034"
        ) {
            this.logger.warn(
                `[IDENTITY] Serialization conflict for ${type}, user ${userId} (attempt ${attempt}/${IdentityResolutionService.MAX_RETRIES})`,
            );
            return true;
        }

        this.logger.error(
            `[IDENTITY] Resolution failed for ${type}, user ${userId}: ${this.formatUnknownError(error)}`,
        );
        throw error;
    }

    private async executeResolutionTransaction<T>(
        fn: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> {
        return this.prisma.$transaction(fn, {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            timeout: DB_TRANSACTION_TIMEOUT,
        });
    }

    private async resolveOrCreateInner(
        tx: Prisma.TransactionClient,
        type: IdentityIdType,
        valueHash: string,
        maskedValue: string,
        userId: number,
        biographic?: BiographicData,
    ): Promise<IdentityResolutionResult> {
        // Step 1: Look for existing identifier
        const existingIdentifier = await tx.identityIdentifier.findUnique({
            where: {
                type_valueHash: { type, valueHash },
            },
            include: {
                subject: { include: { user: true } },
            },
        });

        if (existingIdentifier) {
            const subject = existingIdentifier.subject;

            // Already linked to a different active user → DUPLICATE
            if (subject.user && subject.user.id !== userId) {
                this.logger.warn(
                    `[IDENTITY][DUPLICATE_BLOCKED] ${type} already linked to user ${subject.user.id}, attempted by user ${userId}`,
                );
                throw new VerificationGenericException(
                    `This ${type} is already linked to another account. If this is yours, please contact support.`,
                    HttpStatus.CONFLICT,
                );
            }

            // Same user, idempotent
            if (subject.user?.id === userId) {
                this.logger.log(
                    `[IDENTITY] Idempotent resolve for user ${userId}, subject ${subject.id}`,
                );
                return { subjectId: subject.id, isNew: false };
            }

            // Subject exists but not linked to any user (orphaned) → link it
            await tx.user.update({
                where: { id: userId },
                data: { identitySubjectId: subject.id },
            });
            this.logger.log(
                `[IDENTITY] Linked orphan subject ${subject.id} to user ${userId}`,
            );
            return { subjectId: subject.id, isNew: false };
        }

        // Step 2: No existing identifier — check if user already has a subject
        const currentUser = await tx.user.findUniqueOrThrow({
            where: { id: userId },
            select: { identitySubjectId: true },
        });

        let subjectId: number;
        let isNew = false;

        if (currentUser.identitySubjectId) {
            // User already has a subject (e.g. BVN verified, now verifying NIN)
            subjectId = currentUser.identitySubjectId;
            this.logger.log(
                `[IDENTITY] Adding ${type} to existing subject ${subjectId} for user ${userId}`,
            );
        } else {
            // Create new subject + link to user
            const newSubject = await tx.identitySubject.create({
                data: {},
            });
            subjectId = newSubject.id;
            isNew = true;

            await tx.user.update({
                where: { id: userId },
                data: { identitySubjectId: subjectId },
            });
            this.logger.log(
                `[IDENTITY] Created new subject ${subjectId} for user ${userId}`,
            );
        }

        // Step 3: Create the identifier
        await tx.identityIdentifier.create({
            data: {
                subjectId,
                type,
                valueHash,
                maskedValue,
                verifiedAt: new Date(),
            },
        });

        // Step 3b: Cross-ID-type check via NAME_DOB biographic hash
        if (biographic) {
            await this.resolveNameDobIdentifier(tx, subjectId, userId, biographic);
        }

        // Step 4: Cross-check — ensure no other user holds a different
        // identifier that maps to the same subject
        await this.crossCheckWithinTransaction(tx, userId, subjectId);

        this.logger.log(
            `[IDENTITY] ${type} resolved → subject ${subjectId} (new=${isNew}) for user ${userId}`,
        );
        return { subjectId, isNew };
    }

    /**
     * Resolve a NAME_DOB identifier within the same transaction.
     * If the same name+DOB hash already exists on a DIFFERENT subject
     * (linked to a different user), this means the same person used two
     * different accounts with different ID types → block.
     */
    private async resolveNameDobIdentifier(
        tx: Prisma.TransactionClient,
        subjectId: number,
        userId: number,
        biographic: BiographicData,
    ): Promise<void> {
        const nameDobHash = this.hashBiographic(biographic);
        const maskedName = `${biographic.firstName.charAt(0)}***${biographic.lastName.charAt(0)}***`;

        const existing = await tx.identityIdentifier.findUnique({
            where: {
                type_valueHash: { type: IdentityIdType.NAME_DOB, valueHash: nameDobHash },
            },
            include: {
                subject: { include: { user: true } },
            },
        });

        if (existing) {
            const ownerSubject = existing.subject;

            // Same subject (same user adding another ID type) → idempotent
            if (ownerSubject.id === subjectId) {
                return;
            }

            // Different subject linked to a different user → DUPLICATE
            if (ownerSubject.user && ownerSubject.user.id !== userId) {
                this.logger.warn(
                    `[IDENTITY][NAME_DOB_BLOCKED] Biographic match: subject ${ownerSubject.id} (user ${ownerSubject.user.id}) vs subject ${subjectId} (user ${userId})`,
                );
                throw new VerificationGenericException(
                    "An account with the same identity already exists. If this is yours, please contact support.",
                    HttpStatus.CONFLICT,
                );
            }

            // Orphan subject → skip (shouldn't normally happen)
            return;
        }

        // No existing NAME_DOB → create one on this subject
        await tx.identityIdentifier.create({
            data: {
                subjectId,
                type: IdentityIdType.NAME_DOB,
                valueHash: nameDobHash,
                maskedValue: maskedName,
                verifiedAt: new Date(),
            },
        });

        this.logger.log(
            `[IDENTITY] NAME_DOB identifier created for subject ${subjectId}, user ${userId}`,
        );
    }

    /**
     * Cross-check within a transaction: ensure no OTHER user is linked to the same subject.
     */
    private async crossCheckWithinTransaction(
        tx: Prisma.TransactionClient,
        userId: number,
        subjectId: number,
    ): Promise<void> {
        const conflictingUser = await tx.user.findFirst({
            where: {
                identitySubjectId: subjectId,
                id: { not: userId },
            },
            select: { id: true },
        });

        if (conflictingUser) {
            this.logger.warn(
                `[IDENTITY][CROSS_CHECK] Subject ${subjectId} already linked to user ${conflictingUser.id}, conflict with user ${userId}`,
            );
            throw new VerificationGenericException(
                "Identity conflict detected. This identity is already linked to another account. Please contact support.",
                HttpStatus.CONFLICT,
            );
        }
    }

    /**
     * Get the subject for a user (if it exists).
     */
    async getSubjectForUser(
        userId: number,
    ): Promise<{ subjectId: number; identifiers: { type: IdentityIdType; maskedValue: string }[] } | null> {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                identitySubject: {
                    include: {
                        identifiers: {
                            select: { type: true, maskedValue: true },
                        },
                    },
                },
            },
        });

        if (!user?.identitySubject) return null;

        return {
            subjectId: user.identitySubject.id,
            identifiers: user.identitySubject.identifiers,
        };
    }
}
