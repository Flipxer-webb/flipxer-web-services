import "dotenv/config";
import { PrismaClient, UserType } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { customAlphabet } from "nanoid";

const prisma = new PrismaClient({
    log: ["error", "warn"],
});
const SALT_ROUNDS = 10;
const generateIdentifier = customAlphabet(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    16,
);
const FIXTURE_PASSWORD_SUFFIX = "@2024!";

interface TestUser {
    email: string;
    legacyEmail?: string;
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

function buildFixturePassword(label: string): string {
    return `${label}${FIXTURE_PASSWORD_SUFFIX}`;
}

const testUsers: TestUser[] = [
    {
        email: "tier0.test@flipxer.local",
        legacyEmail: "tier0.test@flipxer.com",
        password: buildFixturePassword("TierZero"),
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
        email: "tier1.test@flipxer.local",
        legacyEmail: "tier1.test@flipxer.com",
        password: buildFixturePassword("TierOne"),
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
        email: "tier2.test@flipxer.local",
        legacyEmail: "tier2.test@flipxer.com",
        password: buildFixturePassword("TierTwo"),
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
        bvn: "22222222223",
        nin: "33333333333",
    },
];

const defaultAccountLimit = {
    sellTokenFiat: 50000,
    buyToken: "unlimited",
    swapToken: "unlimited",
    sendToken: 50000,
    receiveToken: "unlimited",
} as const;

function buildUserPayload(
    user: TestUser,
    hashedPassword: string,
    roleId: number,
) {
    return {
        email: user.email,
        phone: user.phone,
        userType: UserType.INDIVIDUAL,
        password: hashedPassword,
        firstName: user.firstName,
        lastName: user.lastName,
        tier: user.tier,
        isEmailVerified: user.isEmailVerified,
        isPhoneVerified: user.isPhoneVerified,
        isPasswordCreated: user.isPasswordCreated,
        isDocumentVerified: user.isDocumentVerified,
        bvn: user.bvn,
        nin: user.nin,
        role: {
            connect: {
                id: roleId,
            },
        },
    };
}

async function findExistingTierUser(user: TestUser) {
    const currentUser = await prisma.user.findUnique({
        where: { email: user.email },
    });

    if (currentUser) {
        return currentUser;
    }

    const phoneUser = await prisma.user.findUnique({
        where: { phone: user.phone },
    });

    if (phoneUser) {
        return phoneUser;
    }

    if (!user.legacyEmail) {
        return null;
    }

    return prisma.user.findUnique({
        where: { email: user.legacyEmail },
    });
}

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

    console.log(
        `Found role: ${individualRole.name} (ID: ${individualRole.id})\n`,
    );

    for (const user of testUsers) {
        try {
            const hashedPassword = await bcrypt.hash(
                user.password,
                SALT_ROUNDS,
            );
            const userPayload = buildUserPayload(
                user,
                hashedPassword,
                individualRole.id,
            );
            const existingUser = await findExistingTierUser(user);

            const created = existingUser
                ? await prisma.user.update({
                      where: { id: existingUser.id },
                      data: userPayload,
                  })
                : await prisma.user.create({
                      data: {
                          ...userPayload,
                          identifier: generateIdentifier(),
                      },
                  });

            await prisma.accountLimit.upsert({
                where: { userId: created.id },
                update: defaultAccountLimit,
                create: {
                    userId: created.id,
                    ...defaultAccountLimit,
                },
            });

            console.log(`✓ Tier ${user.tier}: ${user.email}`);
            console.log("  Password source: tier-user seed fixture");
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
        console.log(
            `Tier ${user.tier}: ${user.email} / password source: tier-user seed fixture`,
        );
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
