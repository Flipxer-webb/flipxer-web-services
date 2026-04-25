/**
 * Script to create a test super admin for E2E testing
 * Run with: npx ts-node prisma/scripts/create-test-admin.ts
 */

import { PrismaClient, UserType } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { customAlphabet } from "nanoid";

const prisma = new PrismaClient();
const SALT_ROUNDS = 10;

const TEST_ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || "test-admin@flipxer.local";
const TEST_ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD;

async function main() {
    console.log("🔧 Creating test super admin...\n");

    if (!TEST_ADMIN_PASSWORD) {
        console.error("❌ TEST_ADMIN_PASSWORD environment variable is required.");
        process.exit(1);
    }

    // Find the super-admin role
    const superAdminRole = await prisma.role.findUnique({
        where: { slug: "super-admin" },
    });

    if (!superAdminRole) {
        console.error("❌ Super admin role not found! Please run seed first.");
        process.exit(1);
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(TEST_ADMIN_PASSWORD, SALT_ROUNDS);

    // Generate unique identifier and phone
    const generateId = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789", 16);
    const generatePhone = customAlphabet("0123456789", 10);
    const identifier = generateId();
    const uniquePhone = "090" + generatePhone();

    // Check if admin already exists
    const existingAdmin = await prisma.user.findUnique({
        where: { email: TEST_ADMIN_EMAIL },
    });

    if (existingAdmin) {
        // Update existing admin
        const testAdmin = await prisma.user.update({
            where: { email: TEST_ADMIN_EMAIL },
            data: {
                password: hashedPassword,
                firstName: "Test",
                lastName: "Admin",
                isEmailVerified: true,
                isPasswordCreated: true,
            },
        });
        console.log("✅ Test super admin updated successfully!\n");
        console.log("📧 Email:", TEST_ADMIN_EMAIL);
        console.log("🔑 Password source: TEST_ADMIN_PASSWORD");
        console.log("👤 Name:", testAdmin.firstName, testAdmin.lastName);
        console.log("🆔 ID:", testAdmin.id);
        console.log("\n🧪 Use these credentials for Playwright admin tests.\n");
        return;
    }

    // Create new admin
    const testAdmin = await prisma.user.create({
        data: {
            email: TEST_ADMIN_EMAIL,
            phone: uniquePhone,
            userType: UserType.ADMIN,
            identifier: identifier,
            password: hashedPassword,
            roleId: superAdminRole.id,
            firstName: "Test",
            lastName: "Admin",
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

    console.log("✅ Test super admin created successfully!\n");
    console.log("📧 Email:", TEST_ADMIN_EMAIL);
    console.log("🔑 Password source: TEST_ADMIN_PASSWORD");
    console.log("👤 Name:", testAdmin.firstName, testAdmin.lastName);
    console.log("🆔 ID:", testAdmin.id);
    console.log("🏷️ Role ID:", superAdminRole.id);
    console.log("\n🧪 Use these credentials for Playwright admin tests.\n");
}

main()
    .catch((e) => {
        console.error("❌ Error creating test admin:", e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
