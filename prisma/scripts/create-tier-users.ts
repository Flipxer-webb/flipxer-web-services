import "dotenv/config";
import { PrismaClient, UserType } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { customAlphabet } from "nanoid";

const prisma = new PrismaClient({
    log: ['error', 'warn'],
});
const SALT_ROUNDS = 10;
const generateIdentifier = customAlphabet("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 16);

interface TestUser {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    phone: string;
    tier: number;
    isEmailVerified: boolean;
    isPhoneVerified: boolean;
    isPasswordCreated: boolean;
    isBvnVerified: boolean;
    isNinVerified: boolean;
    isDocumentVerified: boolean;
    isAddressVerified: boolean;
    bvn?: string;
    nin?: string;
}

const testUsers: TestUser[] = [
    {
        email: "tier0.test@flipxer.com",
        password: process.env.TEST_TIER0_PASSWORD || "TierZero@2024!",
        firstName: "Tier0",
        lastName: "TestUser",
        phone: "09088880000",
        tier: 0,
        isEmailVerified: true,
        isPhoneVerified: false,
        isPasswordCreated: true,
        isBvnVerified: false,
        isNinVerified: false,
        isDocumentVerified: false,
        isAddressVerified: false,
    },
    {
        email: "tier1.test@flipxer.com",
        password: process.env.TEST_TIER1_PASSWORD || "TierOne@2024!",
        firstName: "Tier1",
        lastName: "TestUser",
        phone: "09088881111",
        tier: 1,
        isEmailVerified: true,
        isPhoneVerified: true,
        isPasswordCreated: true,
        isBvnVerified: true,
        isNinVerified: false,
        isDocumentVerified: true,
        isAddressVerified: false,
        bvn: "11111111111",
    },
    {
        email: "tier2.test@flipxer.com",
        password: process.env.TEST_TIER2_PASSWORD || "TierTwo@2024!",
        firstName: "Tier2",
        lastName: "TestUser",
        phone: "09088882222",
        tier: 2,
        isEmailVerified: true,
        isPhoneVerified: true,
        isPasswordCreated: true,
        isBvnVerified: true,
        isNinVerified: true,
        isDocumentVerified: true,
        isAddressVerified: true,
        bvn: "22222222222",
        nin: "33333333333",
    },
];

async function main() {
    console.log("Creating test users with tiers 0, 1, 2...\n");

    // Get the individual role
    const individualRole = await prisma.role.findUnique({
        where: { slug: "individual" },
    });

    if (!individualRole) {
        console.error("ERROR: Individual role not found. Run seed first.");
        process.exit(1);
    }

    console.log(`Found role: ${individualRole.name} (ID: ${individualRole.id})\n`);

    for (const user of testUsers) {
        try {
            const hashedPassword = await bcrypt.hash(user.password, SALT_ROUNDS);

            const created = await prisma.user.upsert({
                where: { email: user.email },
                update: {
                    password: hashedPassword,
                    tier: user.tier,
                    isEmailVerified: user.isEmailVerified,
                    isPhoneVerified: user.isPhoneVerified,
                    isPasswordCreated: user.isPasswordCreated,
                    isBvnVerified: user.isBvnVerified,
                    isNinVerified: user.isNinVerified,
                    isDocumentVerified: user.isDocumentVerified,
                    isAddressVerified: user.isAddressVerified,
                },
                create: {
                    email: user.email,
                    phone: user.phone,
                    userType: UserType.INDIVIDUAL,
                    identifier: generateIdentifier(),
                    password: hashedPassword,
                    roleId: individualRole.id,
                    firstName: user.firstName,
                    lastName: user.lastName,
                    tier: user.tier,
                    isEmailVerified: user.isEmailVerified,
                    isPhoneVerified: user.isPhoneVerified,
                    isPasswordCreated: user.isPasswordCreated,
                    isBvnVerified: user.isBvnVerified,
                    isNinVerified: user.isNinVerified,
                    isDocumentVerified: user.isDocumentVerified,
                    isAddressVerified: user.isAddressVerified,
                    bvn: user.bvn,
                    nin: user.nin,
                    accountLimit: {
                        create: {
                            sellTokenFiat: 50000,
                            buyToken: "unlimited",
                            swapToken: "unlimited",
                            sendToken: 50000,
                            receiveToken: "unlimited",
                        },
                    },
                },
            });

            console.log(`✓ Tier ${user.tier}: ${user.email}`);
            console.log(`  Password: ${user.password}`);
            console.log(`  User ID: ${created.id}`);
            console.log("");
        } catch (error) {
            console.error(`✗ Failed to create ${user.email}:`, error);
        }
    }

    console.log("\n========================================");
    console.log("TEST USER CREDENTIALS SUMMARY");
    console.log("========================================");
    for (const user of testUsers) {
        console.log(`Tier ${user.tier}: ${user.email} / ${user.password}`);
    }
    console.log("========================================\n");
}

main()
    .then(() => {
        console.log("Done!");
    })
    .catch((err) => {
        console.error("Error:", err);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
