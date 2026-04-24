import "dotenv/config";
import {
    DocumentVerificationStatus,
    KycVerificationType,
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
            isBvnVerified: true,
            isNinVerified: true,
            isDocumentVerified: true,
            isAddressVerified: true,
            isIncomeVerified: false,
            documentVerificationStatus: DocumentVerificationStatus.VERIFIED,
            addressVerificationStatus: DocumentVerificationStatus.VERIFIED,
            incomeVerificationStatus: DocumentVerificationStatus.PENDING,
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
            isBvnVerified: true,
            isNinVerified: true,
            isDocumentVerified: true,
            isAddressVerified: true,
            isIncomeVerified: false,
            documentVerificationStatus: DocumentVerificationStatus.VERIFIED,
            addressVerificationStatus: DocumentVerificationStatus.VERIFIED,
            incomeVerificationStatus: DocumentVerificationStatus.PENDING,
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

    await prisma.kycVerification.updateMany({
        where: {
            userId: user.id,
            verificationType: KycVerificationType.INCOME,
            isActive: true,
        },
        data: { isActive: false },
    });

    const latestIncomeVerification = await prisma.kycVerification.findFirst({
        where: {
            userId: user.id,
            verificationType: KycVerificationType.INCOME,
        },
        orderBy: [
            { version: "desc" },
            { createdAt: "desc" },
        ],
        select: {
            version: true,
        },
    });

    await prisma.kycVerification.create({
        data: {
            userId: user.id,
            verificationType: KycVerificationType.INCOME,
            status: "PENDING",
            documentUrl: TEST_USER.incomeDocumentUrl,
            version: (latestIncomeVerification?.version ?? 0) + 1,
            isActive: true,
        },
    });

    console.log("Income review test user ready");
    console.log(`  Email: ${TEST_USER.email}`);
    console.log(`  User ID: ${user.id}`);
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