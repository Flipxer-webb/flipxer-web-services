import "dotenv/config";
import {
    DocumentVerificationStatus,
    KycDecisionMode,
    KycJourneyType,
    KycMethod,
    KycAttemptStatus,
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
const TEST_USER_PASSWORD = process.env.LOCAL_TEST_INCOME_READY_PASSWORD ?? ["Income", "Ready", "@2024!"].join("");

const TEST_USER = {
    email: "income-ready.test@flipxer.local",
    firstName: "Income",
    lastName: "ReadyUser",
    phone: "09088885555",
    bvn: "91000000003",
    nin: "91000000004",
    residentialAddress: "12 Idowu Taylor Street, Victoria Island, Lagos",
    dateOfBirth: new Date("1991-04-12T00:00:00.000Z"),
    identityDocumentUrl:
        "https://ik.imagekit.io/tmgaa5sb4/user-documents/identity/income-ready-identity-passport.pdf",
    addressDocumentUrl:
        "https://ik.imagekit.io/tmgaa5sb4/user-documents/address/income-ready-address-utility-bill.pdf",
} as const;

function daysAgo(days: number) {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

type StageFixture = {
    stage: KycStage;
    method: KycMethod;
    submittedAt: Date;
    reviewedAt: Date;
    extractedFields: Prisma.InputJsonValue;
    evidenceSummary: Prisma.InputJsonValue;
};

const APPROVED_STAGE_FIXTURES: StageFixture[] = [
    {
        stage: KycStage.GOVERNMENT_ID,
        method: KycMethod.BVN,
        submittedAt: daysAgo(45),
        reviewedAt: daysAgo(44),
        extractedFields: {
            identifierType: "BVN",
            identifier: TEST_USER.bvn,
            verified: true,
        } as Prisma.InputJsonValue,
        evidenceSummary: {
            source: "LOCAL_TEST_FIXTURE",
            identifierType: "BVN",
            identifier: TEST_USER.bvn,
        } as Prisma.InputJsonValue,
    },
    {
        stage: KycStage.IDENTITY_DOCUMENT,
        method: KycMethod.INTERNATIONAL_PASSPORT,
        submittedAt: daysAgo(21),
        reviewedAt: daysAgo(20),
        extractedFields: {
            documentType: "INTERNATIONAL_PASSPORT",
            fullName: `${TEST_USER.firstName} ${TEST_USER.lastName}`,
            countryCode: "NG",
        } as Prisma.InputJsonValue,
        evidenceSummary: {
            source: "LOCAL_TEST_FIXTURE",
            identityDocumentUrl: TEST_USER.identityDocumentUrl,
            documentType: "INTERNATIONAL_PASSPORT",
        } as Prisma.InputJsonValue,
    },
    {
        stage: KycStage.ADDRESS,
        method: KycMethod.UTILITY_BILL,
        submittedAt: daysAgo(10),
        reviewedAt: daysAgo(9),
        extractedFields: {
            fullName: `${TEST_USER.firstName} ${TEST_USER.lastName}`,
            country: "Nigeria",
            matchedProfileName: true,
            withinLastThreeMonths: true,
        } as Prisma.InputJsonValue,
        evidenceSummary: {
            source: "LOCAL_TEST_FIXTURE",
            addressDocumentUrl: TEST_USER.addressDocumentUrl,
            documentType: "UTILITY_BILL",
            country: "Nigeria",
        } as Prisma.InputJsonValue,
    },
];

async function ensureRole() {
    const individualRole = await prisma.role.findUnique({
        where: { slug: "individual" },
    });

    if (!individualRole) {
        throw new Error("Individual role not found. Run seed first.");
    }

    return individualRole;
}

function buildStageScope(userId: number, stage: StageFixture["stage"]): Prisma.KycStageAttemptWhereInput {
    switch (stage) {
        case KycStage.GOVERNMENT_ID:
            return {
                userId,
                journeyType: KycJourneyType.INDIVIDUAL,
                stage: KycStage.GOVERNMENT_ID,
            };
        case KycStage.IDENTITY_DOCUMENT:
            return {
                userId,
                journeyType: KycJourneyType.INDIVIDUAL,
                stage: KycStage.IDENTITY_DOCUMENT,
            };
        case KycStage.ADDRESS:
            return {
                userId,
                journeyType: KycJourneyType.INDIVIDUAL,
                stage: KycStage.ADDRESS,
            };
        default:
            throw new Error(`Unsupported approved stage fixture: ${stage}`);
    }
}

async function upsertApprovedStageAttempt(userId: number, fixture: StageFixture) {
    const stageScope = buildStageScope(userId, fixture.stage);
    const latestAttempt = await prisma.kycStageAttempt.findFirst({
        where: stageScope,
        orderBy: [{ attemptNo: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
        select: {
            id: true,
            attemptNo: true,
        },
    });

    const currentAttempts = await prisma.kycStageAttempt.findMany({
        where: {
            ...stageScope,
            isCurrent: true,
        },
        select: {
            id: true,
        },
    });

    for (const currentAttempt of currentAttempts) {
        if (latestAttempt && currentAttempt.id === latestAttempt.id) {
            continue;
        }

        await prisma.kycStageAttempt.update({
            where: { id: currentAttempt.id },
            data: {
                isCurrent: false,
            },
        });
    }

    if (latestAttempt) {
        return prisma.kycStageAttempt.update({
            where: { id: latestAttempt.id },
            data: {
                method: fixture.method,
                isCurrent: true,
                status: KycAttemptStatus.APPROVED,
                providerName: KycProviderName.NONE,
                providerStatus: KycProviderStatus.PASSED,
                decisionMode: KycDecisionMode.AUTO,
                providerRef: null,
                reviewerId: null,
                reviewNote: null,
                reviewedAt: fixture.reviewedAt,
                escalatedAt: null,
                reasonCode: null,
                reasonMessage: null,
                reasonDetails: Prisma.DbNull,
                extractedFields: fixture.extractedFields,
                comparisonSummary: Prisma.DbNull,
                evidenceSummary: fixture.evidenceSummary,
                submittedAt: fixture.submittedAt,
            },
            select: { id: true },
        });
    }

    return prisma.kycStageAttempt.create({
        data: {
            userId,
            journeyType: KycJourneyType.INDIVIDUAL,
            stage: fixture.stage,
            method: fixture.method,
            attemptNo: 1,
            isCurrent: true,
            status: KycAttemptStatus.APPROVED,
            providerName: KycProviderName.NONE,
            providerStatus: KycProviderStatus.PASSED,
            decisionMode: KycDecisionMode.AUTO,
            providerRef: null,
            reviewerId: null,
            reviewNote: null,
            reviewedAt: fixture.reviewedAt,
            escalatedAt: null,
            reasonCode: null,
            reasonMessage: null,
            reasonDetails: Prisma.DbNull,
            extractedFields: fixture.extractedFields,
            comparisonSummary: Prisma.DbNull,
            evidenceSummary: fixture.evidenceSummary,
            submittedAt: fixture.submittedAt,
        },
        select: { id: true },
    });
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
            tier: 2,
            isEmailVerified: true,
            isPhoneVerified: true,
            isPasswordCreated: true,
            isDocumentVerified: true,
            documentVerificationStatus: DocumentVerificationStatus.VERIFIED,
            addressDocumentUrl: TEST_USER.addressDocumentUrl,
            incomeDocumentUrl: null,
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
            tier: 2,
            isEmailVerified: true,
            isPhoneVerified: true,
            isPasswordCreated: true,
            isDocumentVerified: true,
            documentVerificationStatus: DocumentVerificationStatus.VERIFIED,
            addressDocumentUrl: TEST_USER.addressDocumentUrl,
        },
    });

    await prisma.accountLimit.upsert({
        where: { userId: user.id },
        update: {
            sellTokenFiat: 1000000,
            buyToken: "unlimited",
            swapToken: "unlimited",
            sendToken: 1000000,
            receiveToken: "unlimited",
        },
        create: {
            userId: user.id,
            sellTokenFiat: 1000000,
            buyToken: "unlimited",
            swapToken: "unlimited",
            sendToken: 1000000,
            receiveToken: "unlimited",
        },
    });

    for (const fixture of APPROVED_STAGE_FIXTURES) {
        await upsertApprovedStageAttempt(user.id, fixture);
    }

    await prisma.kycStageAttempt.updateMany({
        where: {
            userId: user.id,
            journeyType: KycJourneyType.INDIVIDUAL,
            stage: KycStage.INCOME,
            isCurrent: true,
        },
        data: {
            isCurrent: false,
        },
    });

    console.log("Income ready test user ready");
    console.log(`  Email: ${TEST_USER.email}`);
    console.log(`  Password: ${TEST_USER_PASSWORD}`);
    console.log(`  User ID: ${user.id}`);
    console.log("  State: GOVERNMENT_ID, IDENTITY_DOCUMENT, and ADDRESS approved; INCOME ready to submit");
}

main()
    .catch((error) => {
        console.error("Failed to set up income ready test user:", error);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });