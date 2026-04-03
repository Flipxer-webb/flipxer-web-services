#!/usr/bin/env node
/**
 * Admin Bootstrap CLI Tool
 * 
 * Creates a super admin user directly in the database without needing UI access.
 * This is useful for:
 * - Initial setup of the admin system
 * - Recovery when all admin accounts are locked out
 * - Creating admins in environments where the UI isn't accessible
 * 
 * Usage:
 *   npx ts-node prisma/scripts/bootstrap-admin.ts
 *   
 * Or with arguments:
 *   npx ts-node prisma/scripts/bootstrap-admin.ts --email admin@example.com --password MyPassword123!
 */

import { PrismaClient, UserType } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { customAlphabet } from "nanoid";
import * as readline from "node:readline";

const prisma = new PrismaClient();
const SALT_ROUNDS = 10;

// Utility to create readline interface for prompts
function createReadline() {
    return readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
}

// Prompt for input
function prompt(rl: readline.Interface, question: string, isPassword = false): Promise<string> {
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            resolve(answer.trim());
        });
    });
}

// Parse command line arguments
function parseArgs(): { email?: string; password?: string; firstName?: string; lastName?: string } {
    const args: { email?: string; password?: string; firstName?: string; lastName?: string } = {};
    const argv = process.argv.slice(2);

    for (let i = 0; i < argv.length; i++) {
        switch (argv[i]) {
            case "--email":
            case "-e":
                args.email = argv[++i];
                break;
            case "--password":
            case "-p":
                args.password = argv[++i];
                break;
            case "--first-name":
            case "-f":
                args.firstName = argv[++i];
                break;
            case "--last-name":
            case "-l":
                args.lastName = argv[++i];
                break;
            case "--help":
            case "-h":
                console.log(`
Admin Bootstrap CLI Tool

Creates a super admin user directly in the database.

Usage:
  npx ts-node prisma/scripts/bootstrap-admin.ts [options]

Options:
  -e, --email <email>       Admin email address
  -p, --password <password> Admin password (min 8 characters)
  -f, --first-name <name>   First name (default: Super)
  -l, --last-name <name>    Last name (default: Admin)
  -h, --help                Show this help message

Examples:
  # Interactive mode (prompts for all values)
  npx ts-node prisma/scripts/bootstrap-admin.ts

  # With arguments
  npx ts-node prisma/scripts/bootstrap-admin.ts -e admin@flipxer.com -p SecurePassword123!

  # Full specification
  npx ts-node prisma/scripts/bootstrap-admin.ts -e admin@flipxer.com -p SecurePassword123! -f John -l Doe
`);
                process.exit(0);
        }
    }

    return args;
}

// Validate email format (simple check without regex backtracking risk)
function isValidEmail(email: string): boolean {
    if (email.length > 254) return false;
    const atIndex = email.indexOf('@');
    if (atIndex < 1 || atIndex !== email.lastIndexOf('@')) return false;
    const domain = email.substring(atIndex + 1);
    if (!domain || domain.length < 3 || !domain.includes('.')) return false;
    if (email.includes(' ')) return false;
    return true;
}

// Validate password strength
function isValidPassword(password: string): { valid: boolean; message?: string } {
    if (password.length < 8) {
        return { valid: false, message: "Password must be at least 8 characters long" };
    }
    return { valid: true };
}

async function main() {
    console.log("\n🔐 Admin Bootstrap CLI Tool\n");
    console.log("═".repeat(50) + "\n");

    const args = parseArgs();
    const rl = createReadline();

    try {
        // Check database connection
        console.log("📡 Connecting to database...");
        await prisma.$connect();
        console.log("✅ Database connected!\n");

        // Find the super-admin role
        const superAdminRole = await prisma.role.findUnique({
            where: { slug: "super-admin" },
        });

        if (!superAdminRole) {
            console.error("❌ Super Admin role not found!");
            console.error("   Please run the database seed first: npx prisma db seed");
            process.exit(1);
        }

        console.log(`📋 Found Super Admin role (ID: ${superAdminRole.id})\n`);

        // Get or prompt for email
        let email = args.email;
        while (!email || !isValidEmail(email)) {
            if (email && !isValidEmail(email)) {
                console.log("⚠️  Invalid email format. Please try again.\n");
            }
            email = await prompt(rl, "📧 Enter admin email: ");
        }

        // Check if email already exists
        const existingUser = await prisma.user.findUnique({
            where: { email },
        });

        if (existingUser) {
            console.log(`\n⚠️  User with email "${email}" already exists.`);
            const updateChoice = await prompt(rl, "Do you want to update this user's password? (y/n): ");

            if (updateChoice.toLowerCase() === "y" || updateChoice.toLowerCase() === "yes") {
                let password = args.password;
                while (!password) {
                    password = await prompt(rl, "🔑 Enter new password (min 8 chars): ");
                    const validation = isValidPassword(password);
                    if (!validation.valid) {
                        console.log(`⚠️  ${validation.message}\n`);
                        password = undefined;
                    }
                }

                const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

                await prisma.user.update({
                    where: { email },
                    data: {
                        password: hashedPassword,
                        isPasswordCreated: true,
                        roleId: superAdminRole.id, // Ensure they have super admin role
                    },
                });

                console.log("\n" + "═".repeat(50));
                console.log("\n✅ Password updated successfully!\n");
                console.log("📧 Email:", email);
                console.log("🔑 Password: [REDACTED]");
                console.log("🛡️  Role: Super Admin");
                console.log("\n" + "═".repeat(50));
            } else {
                console.log("\n❌ Operation cancelled.");
            }

            rl.close();
            return;
        }

        // Get or prompt for password
        let password = args.password;
        while (!password) {
            password = await prompt(rl, "🔑 Enter password (min 8 chars): ");
            const validation = isValidPassword(password);
            if (!validation.valid) {
                console.log(`⚠️  ${validation.message}\n`);
                password = undefined;
            }
        }

        // Get or prompt for names
        const firstName = args.firstName || await prompt(rl, "👤 First name (default: Super): ") || "Super";
        const lastName = args.lastName || await prompt(rl, "👤 Last name (default: Admin): ") || "Admin";

        // Generate unique identifiers
        const generateId = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789", 16);
        const generatePhone = customAlphabet("0123456789", 10);
        const identifier = generateId();
        const uniquePhone = "090" + generatePhone();

        // Hash password
        console.log("\n🔒 Hashing password...");
        const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

        // Create the admin user
        console.log("📝 Creating admin user...");
        const newAdmin = await prisma.user.create({
            data: {
                email,
                phone: uniquePhone,
                userType: UserType.ADMIN,
                identifier,
                password: hashedPassword,
                roleId: superAdminRole.id,
                firstName,
                lastName,
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

        rl.close();

        console.log("\n" + "═".repeat(50));
        console.log("\n✅ Super Admin created successfully!\n");
        console.log("📧 Email:", email);
        console.log("🔑 Password: [REDACTED]");
        console.log("👤 Name:", firstName, lastName);
        console.log("🆔 User ID:", newAdmin.id);
        console.log("🛡️  Role: Super Admin");
        console.log("\n💡 You can now log in at: /admin/login");
        console.log("\n" + "═".repeat(50) + "\n");

    } catch (error) {
        rl.close();
        console.error("\n❌ Error:", error);
        process.exit(1);
    }
}

async function bootstrap() {
    try {
        await main();
    } catch (e) {
        console.error("❌ Fatal error:", e);
        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

void bootstrap();
