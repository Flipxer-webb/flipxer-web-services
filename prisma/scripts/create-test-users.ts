/**
 * Create test users for local Docker development and design audit agent.
 * Creates one ADMIN and one INDIVIDUAL user with known credentials.
 *
 * Run with: npx ts-node prisma/scripts/create-test-users.ts
 * Prerequisite: Run seed first (npx prisma db seed) to create roles.
 */

import { PrismaClient, UserType } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { customAlphabet } from "nanoid";

const prisma = new PrismaClient();
const SALT_ROUNDS = 10;
const generateId = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789", 16);
const generatePhone = customAlphabet("0123456789", 10);

// ─── Test credentials ───────────────────────────────────────────
const TEST_ADMIN = {
    email: "audit-admin@flipxer.test",
    password: process.env.TEST_ADMIN_PASSWORD,
    firstName: "Audit",
    lastName: "Admin",
    userType: UserType.ADMIN,
    roleSlug: "super-admin",
};

const TEST_USER = {
    email: "audit-user@flipxer.test",
    password: process.env.TEST_USER_PASSWORD,
    firstName: "Audit",
    lastName: "User",
    userType: UserType.INDIVIDUAL,
    roleSlug: "individual",
};
// ─────────────────────────────────────────────────────────────────

if (!TEST_ADMIN.password || !TEST_USER.password) {
    console.error("❌ TEST_ADMIN_PASSWORD and TEST_USER_PASSWORD environment variables are required");
    process.exit(1);
}

async function upsertTestUser(config: typeof TEST_ADMIN | typeof TEST_USER) {
    const role = await prisma.role.findUnique({
        where: { slug: config.roleSlug },
    });

    if (!role) {
        console.error(`❌ Role "${config.roleSlug}" not found. Run seed first: npx prisma db seed`);
        return null;
    }

    const hashedPassword = await bcrypt.hash(config.password, SALT_ROUNDS);
    const identifier = generateId();
    const phone = "090" + generatePhone();

    const user = await prisma.user.upsert({
        where: { email: config.email },
        update: {
            password: hashedPassword,
            firstName: config.firstName,
            lastName: config.lastName,
            isEmailVerified: true,
            isPasswordCreated: true,
        },
        create: {
            email: config.email,
            phone,
            userType: config.userType,
            identifier,
            password: hashedPassword,
            roleId: role.id,
            firstName: config.firstName,
            lastName: config.lastName,
            isEmailVerified: true,
            isPasswordCreated: true,
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

    return user;
}

async function main() {
    console.log("🔧 Creating test users for local Docker testing...\n");

    const admin = await upsertTestUser(TEST_ADMIN);
    if (admin) {
        console.log("✅ Admin user ready");
        console.log(`   📧 ${TEST_ADMIN.email}`);
        console.log("   🔑 [REDACTED]");
        console.log(`   🆔 ID: ${admin.id}  |  Type: ${TEST_ADMIN.userType}\n`);
    }

    const user = await upsertTestUser(TEST_USER);
    if (user) {
        console.log("✅ Individual user ready");
        console.log(`   📧 ${TEST_USER.email}`);
        console.log("   🔑 [REDACTED]");
        console.log(`   🆔 ID: ${user.id}  |  Type: ${TEST_USER.userType}\n`);
    }

    console.log("────────────────────────────────────────────────");
    console.log("Add to flipxer-web-app/.env.local:");
    console.log("");
    console.log(`AUDIT_TEST_EMAIL=${TEST_ADMIN.email}`);
    console.log(`AUDIT_TEST_USER_EMAIL=${TEST_USER.email}`);
    console.log("Configure the remaining audit environment values in flipxer-web-app/.env.local manually.");
    console.log("────────────────────────────────────────────────");
}

async function bootstrap() {
    try {
        await main();
    } catch (e) {
        console.error("❌ Error:", e);
        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

void bootstrap();
