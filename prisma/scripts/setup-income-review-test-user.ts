import "dotenv/config";
import {
    DocumentVerificationStatus,
    KycActorType,
    KycAttemptEventType,
    KycMethod,
    KycAttemptStatus,
    KycDecisionMode,
    KycJourneyType,
    KycProviderName,
    KycProviderStatus,
    KycStage,
    Prisma,
    PrismaClient,
    Status,
    UserType,
} from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { customAlphabet } from "nanoid";

const prisma = new PrismaClient({ log: ["error", "warn"] });
const SALT_ROUNDS = 10;
const generateIdentifier = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789", 16);
const TEST_USER_PASSWORD = process.env.LOCAL_TEST_INCOME_REVIEW_PASSWORD ?? ["Income", "Pend", "@2024!"]
    .join("");

const TEST_USER = {
    email: "income-pending.test@flipxer.local",
    firstName: "Income",
    lastName: "PendingUser",
    phone: "09088884444",
    bvn: "91000000001",
    nin: "91000000002",
    residentialAddress: "23 Admiralty Way, Lekki Phase 1, Lagos",
    dateOfBirth: new Date("1992-08-18T00:00:00.000Z"),
    addressDocumentUrl:
        "https://ik.imagekit.io/tmgaa5sb4/user-documents/address/address-doc-1776858491553-94320_CI6puujqn.webp",
    incomeDocumentUrl:
        "https://ik.imagekit.io/tmgaa5sb4/user-documents/address/address-doc-1776858181964-51915_6bYQqEloGA.pdf",
} as const;

async function ensureRole() {
    const individualRole = await prisma.role.findUnique({
        where: { slug: "individual" },
    });

    if (!individualRole) {
        throw new Error('Individual role not found. Run seed first.');
    }

    return individualRole;
}

async function main() {
    const individualRole = await ensureRole();
    const hashedPassword = await bcrypt.hash(TEST_USER_PASSWORD, SALT_ROUNDS);

    const user = await prisma.user.upsert({
        where: { email: TEST_USER.email },
        update: {
            password: hashedPassword,
            phone: TEST_USER.phone,
            firstName: TEST_USER.firstName,
            lastName: TEST_USER.lastName,
            userType: UserType.INDIVIDUAL,
            status: Status.ACTIVE,
            dateOfBirth: TEST_USER.dateOfBirth,
            residentialAddress: TEST_USER.residentialAddress,
            bvn: TEST_USER.bvn,
            bvnRegisteredPhone: TEST_USER.phone,
            nin: TEST_USER.nin,
            ninRegisteredPhone: TEST_USER.phone,
            roleId: individualRole.id,
            tier: 3,
            isEmailVerified: true,
            isPhoneVerified: true,
            isPasswordCreated: true,
            isDocumentVerified: true,
            documentVerificationStatus: DocumentVerificationStatus.VERIFIED,
            addressDocumentUrl: TEST_USER.addressDocumentUrl,
            incomeDocumentUrl: TEST_USER.incomeDocumentUrl,
        },
        create: {
            email: TEST_USER.email,
            phone: TEST_USER.phone,
            userType: UserType.INDIVIDUAL,
            identifier: generateIdentifier(),
            password: hashedPassword,
            roleId: individualRole.id,
            firstName: TEST_USER.firstName,
            lastName: TEST_USER.lastName,
            status: Status.ACTIVE,
            dateOfBirth: TEST_USER.dateOfBirth,
            residentialAddress: TEST_USER.residentialAddress,
            bvn: TEST_USER.bvn,
            bvnRegisteredPhone: TEST_USER.phone,
            nin: TEST_USER.nin,
            ninRegisteredPhone: TEST_USER.phone,
            tier: 3,
            isEmailVerified: true,
            isPhoneVerified: true,
            isPasswordCreated: true,
            isDocumentVerified: true,
            documentVerificationStatus: DocumentVerificationStatus.VERIFIED,
            addressDocumentUrl: TEST_USER.addressDocumentUrl,
            incomeDocumentUrl: TEST_USER.incomeDocumentUrl,
        },
    });

    await prisma.accountLimit.upsert({
        where: { userId: user.id },
        update: {
            sellTokenFiat: 5000000,
            buyToken: "unlimited",
            swapToken: "unlimited",
            sendToken: 5000000,
            receiveToken: "unlimited",
        },
        create: {
            userId: user.id,
            sellTokenFiat: 5000000,
            buyToken: "unlimited",
            swapToken: "unlimited",
            sendToken: 5000000,
            receiveToken: "unlimited",
        },
    });

    const currentIncomeAttempt = await prisma.kycStageAttempt.findFirst({
        where: {
            userId: user.id,
            journeyType: KycJourneyType.INDIVIDUAL,
            stage: KycStage.INCOME,
            isCurrent: true,
        },
        orderBy: [{ attemptNo: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
        select: {
            id: true,
            submittedAt: true,
        },
    });

    await prisma.kycStageAttempt.updateMany({
        where: {
            userId: user.id,
            journeyType: KycJourneyType.INDIVIDUAL,
            stage: KycStage.INCOME,
            isCurrent: true,
            ...(currentIncomeAttempt ? { id: { not: currentIncomeAttempt.id } } : {}),
        },
        data: {
            isCurrent: false,
        },
    });

    const extractedFields = {
        submissionSource: "LOCAL_TEST_FIXTURE",
        incomeDocumentUrl: TEST_USER.incomeDocumentUrl,
    } as Prisma.InputJsonValue;
    const evidenceSummary = {
        incomeDocumentUrl: TEST_USER.incomeDocumentUrl,
        submissionSource: "LOCAL_TEST_FIXTURE",
    } as Prisma.InputJsonValue;

    const incomeAttempt = currentIncomeAttempt
        ? await prisma.kycStageAttempt.update({
            where: { id: currentIncomeAttempt.id },
            data: {
                isCurrent: true,
                status: KycAttemptStatus.PENDING_REVIEW,
                providerName: KycProviderName.NONE,
                providerStatus: KycProviderStatus.NOT_REQUESTED,
                decisionMode: KycDecisionMode.MANUAL,
                providerRef: null,
                reviewerId: null,
                reviewNote: null,
                reviewedAt: null,
                escalatedAt: null,
                reasonCode: null,
                reasonMessage: null,
                reasonDetails: Prisma.DbNull,
                extractedFields,
                evidenceSummary,
                submittedAt: currentIncomeAttempt.submittedAt ?? new Date(),
            },
            select: { id: true },
        })
        : await prisma.kycStageAttempt.create({
            data: {
                userId: user.id,
                journeyType: KycJourneyType.INDIVIDUAL,
                stage: KycStage.INCOME,
                method: KycMethod.OTHER,
                attemptNo: 1,
                isCurrent: true,
                status: KycAttemptStatus.PENDING_REVIEW,
                providerName: KycProviderName.NONE,
                providerStatus: KycProviderStatus.NOT_REQUESTED,
                decisionMode: KycDecisionMode.MANUAL,
                providerRef: null,
                reviewerId: null,
                reviewNote: null,
                reviewedAt: null,
                escalatedAt: null,
                reasonCode: null,
                reasonMessage: null,
                reasonDetails: Prisma.DbNull,
                extractedFields,
                evidenceSummary,
                submittedAt: new Date(),
            },
            select: { id: true },
        });

    const existingSubmissionEvent = await prisma.kycAttemptEvent.findFirst({
        where: {
            attemptId: incomeAttempt.id,
            eventType: { in: [KycAttemptEventType.SUBMITTED, KycAttemptEventType.RESUBMITTED] },
        },
        select: { id: true },
    });

    if (!existingSubmissionEvent) {
        await prisma.kycAttemptEvent.create({
            data: {
                attemptId: incomeAttempt.id,
                userId: user.id,
                journeyType: KycJourneyType.INDIVIDUAL,
                stage: KycStage.INCOME,
                eventType: KycAttemptEventType.SUBMITTED,
                actorType: KycActorType.USER,
                actorId: user.id,
                providerName: KycProviderName.NONE,
                providerStatus: KycProviderStatus.NOT_REQUESTED,
                note: "Income document submitted for review",
                payload: {
                    source: "LOCAL_TEST_FIXTURE",
                    incomeDocumentUrl: TEST_USER.incomeDocumentUrl,
                } as Prisma.InputJsonValue,
            },
        });
    }

    console.log("Income review test user ready");
    console.log(`  Email: ${TEST_USER.email}`);
    console.log(`  User ID: ${user.id}`);
    console.log(`  Current income attempt ID: ${incomeAttempt.id}`);
    console.log("  State: Tier 3 with submitted income document pending admin review");
}

main()
    .catch((error) => {
        console.error("Failed to set up income review test user:", error);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });