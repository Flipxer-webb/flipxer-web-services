import { PrismaClient, UserType, TransactionFeeCategory } from "@prisma/client";
import logger from "moment-logger"; // Assuming this is your custom logger
import * as bcrypt from "bcryptjs";
import { customAlphabet } from "nanoid"; // For generating verification codes
import { roles } from "./role"; // Assumed roles array file
import { SEED_PASSWORD_CHARSET, SEED_PASSWORD_LENGTH } from "./constants";

// Permission names matching the PermissionNames constant in the RBAC module
const PermissionNames = {
    // Users
    USERS_CREATE: "users.create",
    USERS_READ: "users.read",
    USERS_UPDATE: "users.update",
    USERS_DELETE: "users.delete",
    USERS_BLOCK: "users.block",
    USERS_UNBLOCK: "users.unblock",
    USERS_EXPORT: "users.export",
    USERS_BULK_ACTION: "users.bulk_action",

    // Transactions
    TRANSACTIONS_READ: "transactions.read",
    TRANSACTIONS_UPDATE: "transactions.update",
    TRANSACTIONS_REFUND: "transactions.refund",
    TRANSACTIONS_EXPORT: "transactions.export",
    TRANSACTIONS_MANUAL_APPROVE: "transactions.manual_approve",

    // Settings
    SETTINGS_READ: "settings.read",
    SETTINGS_UPDATE: "settings.update",
    SETTINGS_RATES: "settings.rates",
    SETTINGS_FEES: "settings.fees",

    // Analytics
    ANALYTICS_READ: "analytics.read",
    ANALYTICS_EXPORT: "analytics.export",

    // KYC
    KYC_READ: "kyc.read",
    KYC_APPROVE: "kyc.approve",
    KYC_REJECT: "kyc.reject",
    KYC_ESCALATE: "kyc.escalate",

    // Notifications
    NOTIFICATIONS_READ: "notifications.read",
    NOTIFICATIONS_CREATE: "notifications.create",
    NOTIFICATIONS_BROADCAST: "notifications.broadcast",

    // Roles & Permissions
    ROLES_READ: "roles.read",
    ROLES_CREATE: "roles.create",
    ROLES_UPDATE: "roles.update",
    ROLES_DELETE: "roles.delete",
    ROLES_PERMISSIONS_MANAGE: "roles.permissions_manage",

    // System
    SYSTEM_CONFIG: "system.config",
    SYSTEM_MAINTENANCE: "system.maintenance",
    SYSTEM_AUDIT_LOGS: "system.audit_logs",
} as const;

const prisma = new PrismaClient();
const SALT_ROUNDS = 10; // Number of salt rounds for bcrypt hashing

const generateSeedPassword = customAlphabet(SEED_PASSWORD_CHARSET, SEED_PASSWORD_LENGTH);

const getSeedPassword = (envKey: string, label: string): string => {
    const envPassword = (process.env[envKey] || process.env.SEED_DEFAULT_PASSWORD || "").trim();

    if (envPassword.length >= 12) {
        return envPassword;
    }

    const generated = generateSeedPassword();
    logger.warn(
        `${label} password not provided via ${envKey} or SEED_DEFAULT_PASSWORD; generated a temporary value.`
    );
    logger.info(`${label} temporary password: ${generated}`);
    return generated;
};

async function main() {
    logger.info("Starting database seeding...");

    // Seed transaction fees
    logger.info("Seeding transaction fees...");
    // Supported cryptocurrencies with full Quidax wallet support
    // (can create wallet addresses, buy, sell, send, receive)
    const currencies = [
        "BTC",   // Bitcoin
        "ETH",   // Ethereum
        "USDT",  // Tether
        "USDC",  // USD Coin
        "BNB",   // Binance Coin
        "SOL",   // Solana
        "XRP",   // Ripple
        "ADA",   // Cardano
        "DOGE",  // Dogecoin
        "LTC",   // Litecoin
        "TRX",   // Tron
        "SHIB",  // Shiba Inu
    ];
    const feeCategories = Object.values(TransactionFeeCategory);
    for (const category of feeCategories) {
        for (const currency of currencies) {
            await prisma.transactionFee.upsert({
                where: {
                    category_currency: {
                        category,
                        currency: currency.toUpperCase(),
                    },
                },
                update: {},
                create: {
                    category,
                    currency: currency.toUpperCase(),
                    fee: 0.5, // default fee
                },
            });
        }
    }

    // Seed crypto rates
    logger.info("Seeding crypto rates...");
    for (const currency of currencies) {
        await prisma.cryptoRate.upsert({
            where: { currency },
            update: {},
            create: {
                currency,
                buyRate: 0, // default buy rate
                sellRate: 0, // default sell rate
            },
        });
    }

    // Seed permissions
    logger.info("Seeding permissions...");
    const permissionsList = Object.entries(PermissionNames).map(([key, name]) => {
        const [group] = name.split(".");
        return {
            name,
            description: key.replaceAll("_", " ").toLowerCase(),
            group: group.toUpperCase(),
        };
    });
    for (const perm of permissionsList) {
        await prisma.permission.upsert({
            where: { name: perm.name },
            update: {},
            create: {
                name: perm.name,
                description: perm.description,
                group: perm.group as any,
            },
        });
    }
    logger.info(`Seeded ${permissionsList.length} permissions`);

    // Seed roles
    logger.info("Seeding roles...");
    for (let role of roles) {
        await prisma.role.upsert({
            where: { slug: role.slug },
            update: {},
            create: role,
        });
    }

    // Generate a 6-digit OTP for recovery email verification
    const generateVerificationCode = customAlphabet("1234567890", 6);

    // Seed ADMIN user
    logger.info("Seeding admin user...");
    const adminRole = await prisma.role.findUnique({
        where: { slug: "super-admin" },
    });
    if (adminRole) {
        const plainAdminPassword = getSeedPassword(
            "SEED_ADMIN_PASSWORD",
            "Admin"
        );
        const hashedAdminPassword = await bcrypt.hash(
            plainAdminPassword,
            SALT_ROUNDS
        );
        const admin = await prisma.user.upsert({
            where: { email: "hello@flipxer.com" },
            update: {},
            create: {
                email: "hello@flipxer.com",
                phone: "09010000000",
                userType: UserType.SUPER_ADMIN,
                identifier: "8jhPCbsdSKxKwfgi",
                password: hashedAdminPassword,
                roleId: adminRole.id,
                firstName: "Flipxer",
                lastName: "Admin",
                recoveryEmail: "hello.recovery@flipxer.com",
                accountLimit: {
                    create: {
                        sellTokenFiat: 50000,
                        buyToken: "unlimited",
                        swapToken: "unlimited",
                        sendToken: 50000,
                        receiveToken: "unlimited",
                    },
                },
                bankDetails: {
                    create: [
                        {
                            bankName: "Zenith Bank",
                            accountName: "Flipxer Admin",
                            accountNumber: "1234567891",
                        },
                    ],
                },
            },
        });

        await prisma.recoveryEmailVerificationRequest.upsert({
            where: {
                userId: admin.id,
            },
            update: {
                code: generateVerificationCode(),
            },
            create: {
                userId: admin.id,
                email: "admin.recovery@flipxer.com",
                code: generateVerificationCode(),
                isVerified: false,
            },
        });
    } else {
        logger.error("Super-admin role not found");
    }

    // Seed INDIVIDUAL user (John Doe)
    logger.info("Seeding John Doe user...");
    const individualRole = await prisma.role.findUnique({
        where: { slug: "individual" },
    });
    if (individualRole) {
        const plainIndividualPassword = getSeedPassword(
            "SEED_INDIVIDUAL_PASSWORD",
            "John Doe"
        );
        const hashedIndividualPassword = await bcrypt.hash(
            plainIndividualPassword,
            SALT_ROUNDS
        );
        const individual = await prisma.user.upsert({
            where: { email: "john.doe@example.com" },
            update: {},
            create: {
                email: "john.doe@example.com",
                phone: "09032000001",
                userType: UserType.INDIVIDUAL,
                identifier: "Indv12345",
                password: hashedIndividualPassword,
                roleId: individualRole.id,
                firstName: "John",
                lastName: "Doe",
                recoveryEmail: "john.recovery@example.com",
                accountLimit: {
                    create: {
                        sellTokenFiat: 50000,
                        buyToken: "unlimited",
                        swapToken: "unlimited",
                        sendToken: 50000,
                        receiveToken: "unlimited",
                    },
                },
                bankDetails: {
                    create: [
                        {
                            bankName: "First Bank",
                            accountName: "John Doe",
                            accountNumber: "1234567890",
                        },
                    ],
                },
            },
        });

        await prisma.recoveryEmailVerificationRequest.upsert({
            where: {
                userId: individual.id,
            },
            update: { code: generateVerificationCode() },
            create: {
                userId: individual.id,
                email: "john.recovery@example.com",
                code: generateVerificationCode(),
                isVerified: false,
            },
        });
    } else {
        logger.error("Individual role not found");
    }

    // Seed INDIVIDUAL user (Chidi Nwabeke)
    logger.info("Seeding Chidi Nwabeke user...");
    if (individualRole) {
        const plainChidiPassword = getSeedPassword(
            "SEED_CHIDI_PASSWORD",
            "Chidi Nwabeke"
        );
        const hashedChidiPassword = await bcrypt.hash(
            plainChidiPassword,
            SALT_ROUNDS
        );
        const chidi = await prisma.user.upsert({
            where: { email: "chidi90simeon@gmail.com" },
            update: {},
            create: {
                email: "chidi90simeon@gmail.com",
                phone: "09034000003",
                userType: UserType.INDIVIDUAL,
                identifier: "Chidi67890",
                password: hashedChidiPassword,
                roleId: individualRole.id,
                firstName: "Chidi",
                lastName: "Nwabeke",
                recoveryEmail: "chidi.recovery@example.com",
                accountLimit: {
                    create: {
                        sellTokenFiat: 50000,
                        buyToken: "unlimited",
                        swapToken: "unlimited",
                        sendToken: 50000,
                        receiveToken: "unlimited",
                    },
                },
                bankDetails: {
                    create: [
                        {
                            bankName: "Access Bank",
                            accountName: "Chidi Nwabeke",
                            accountNumber: "9876543210",
                        },
                    ],
                },
            },
        });

        await prisma.recoveryEmailVerificationRequest.upsert({
            where: {
                userId: chidi.id,
            },
            update: { code: generateVerificationCode() },
            create: {
                userId: chidi.id,
                email: "chidi.recovery@example.com",
                code: generateVerificationCode(),
                isVerified: false,
            },
        });
    } else {
        logger.error("Individual role not found for Chidi");
    }

    // Seed VERIFIED INDIVIDUAL user (Jane Smith)
    logger.info("Seeding Jane Smith user (fully verified with document)...");
    if (individualRole) {
        const plainJanePassword = getSeedPassword(
            "SEED_JANE_PASSWORD",
            "Jane Smith"
        );
        const hashedJanePassword = await bcrypt.hash(plainJanePassword, SALT_ROUNDS);
        const jane = await prisma.user.upsert({
            where: { email: "jane.smith@example.com" },
            update: {},
            create: {
                email: "jane.smith@example.com",
                phone: "09035000004",
                userType: UserType.INDIVIDUAL,
                identifier: "Jane12345",
                password: hashedJanePassword,
                roleId: individualRole.id,
                firstName: "Jane",
                lastName: "Smith",
                recoveryEmail: "jane.recovery@example.com",
                bvn: "12345678901", // Sample BVN for verification
                bvnRegisteredPhone: "09035000004", // Matching phone number
                nin: "98765432109", // Sample NIN for verification
                tier: 1, // Tier 1: BVN + Document verified
                isEmailVerified: true, // Email verified
                isPhoneVerified: true, // Phone verified
                isBvnVerified: true, // BVN verified
                isNinVerified: true, // NIN verified
                isDocumentVerified: true, // Document verified
                isPasswordCreated: true, // Password created
                accountLimit: {
                    create: {
                        sellTokenFiat: 50000,
                        buyToken: "unlimited",
                        swapToken: "unlimited",
                        sendToken: 50000,
                        receiveToken: "unlimited",
                    },
                },
                bankDetails: {
                    create: [
                        {
                            bankName: "UBA",
                            accountName: "Jane Smith",
                            accountNumber: "5432109876",
                        },
                    ],
                },
                userDocument: {
                    create: {
                        type: "INTERNATIONAL_PASSPORT",
                        country: "NIGERIA",
                        documentNumber: "A12345678",
                        documentImageUrl: "https://example.com/documents/jane_smith_passport.jpg", // Sample document link
                        documentImageFieldId: "doc_jane_12345",
                    },
                },
            },
        });

        await prisma.recoveryEmailVerificationRequest.upsert({
            where: {
                userId: jane.id,
            },
            update: { code: generateVerificationCode() },
            create: {
                userId: jane.id,
                email: "jane.recovery@example.com",
                code: generateVerificationCode(),
                isVerified: true, // Recovery email verified
            },
        });
    } else {
        logger.error("Individual role not found for Jane Smith");
    }

    // Seed BUSINESS user (Acme Corp)
    logger.info("Seeding Acme Corp user...");
    const businessRole = await prisma.role.findUnique({
        where: { slug: "business" },
    });
    if (businessRole) {
        const plainBusinessPassword = getSeedPassword(
            "SEED_BUSINESS_PASSWORD",
            "Acme Corp"
        );
        const hashedBusinessPassword = await bcrypt.hash(
            plainBusinessPassword,
            SALT_ROUNDS
        );
        const business = await prisma.user.upsert({
            where: { email: "acme.corp@example.com" },
            update: {},
            create: {
                email: "acme.corp@example.com",
                phone: "09033000002",
                userType: UserType.BUSINESS,
                identifier: "Biz67890",
                password: hashedBusinessPassword,
                roleId: businessRole.id,
                firstName: "Acme",
                lastName: "Corp",
                recoveryEmail: "acme.recovery@example.com",
                accountLimit: {
                    create: {
                        sellTokenFiat: 50000,
                        buyToken: "unlimited",
                        swapToken: "unlimited",
                        sendToken: 50000,
                        receiveToken: "unlimited",
                    },
                },
                bankDetails: {
                    create: [
                        {
                            bankName: "GTBank",
                            accountName: "Acme Corp",
                            accountNumber: "0987654321",
                        },
                        {
                            bankName: "Zenith Bank",
                            accountName: "Acme Corp",
                            accountNumber: "1122334455",
                        },
                    ],
                },
            },
        });

        await prisma.recoveryEmailVerificationRequest.upsert({
            where: {
                userId: business.id,
            },
            update: { code: generateVerificationCode() },
            create: {
                userId: business.id,
                email: "acme.recovery@example.com",
                code: generateVerificationCode(),
                isVerified: false,
            },
        });
    } else {
        logger.error("Business role not found");
    }

    // Seed FULLY VERIFIED TEST USER (for testing purposes)
    logger.info("Seeding fully verified test user...");
    if (individualRole) {
        const testUserPassword = process.env.TEST_USER_PASSWORD;
        if (!testUserPassword) { logger.error('TEST_USER_PASSWORD env var required for test user seed'); process.exit(1); }
        const hashedTestPassword = await bcrypt.hash(testUserPassword, SALT_ROUNDS);

        const testUser = await prisma.user.upsert({
            where: { email: "testuser@flipxer.com" },
            update: {
                // Force update password and all verification flags
                password: hashedTestPassword,
                isEmailVerified: true,
                isPhoneVerified: true,
                isPasswordCreated: true,
                isBvnVerified: true,
                isNinVerified: true,
                isDocumentVerified: true,
                isAddressVerified: true,
                // NOTE: Do NOT reset isTwoFactorEnabled here - preserve user's 2FA settings
                tier: 3,
            },
            create: {
                email: "testuser@flipxer.com",
                phone: "09099999999",
                userType: UserType.INDIVIDUAL,
                identifier: "TestUser001",
                password: hashedTestPassword,
                roleId: individualRole.id,
                firstName: "Test",
                lastName: "User",
                dateOfBirth: new Date("1990-01-15"),
                bvn: "22222222222",
                bvnRegisteredPhone: "09099999999",
                nin: "12345678901",
                ninRegisteredPhone: "09099999999",
                recoveryEmail: "testuser.recovery@flipxer.com",
                isEmailVerified: true,
                isPhoneVerified: true,
                isPasswordCreated: true,
                isBvnVerified: true,
                isNinVerified: true,
                isDocumentVerified: true,
                isAddressVerified: true,
                isTwoFactorEnabled: false,
                tier: 3,
                accountLimit: {
                    create: {
                        sellTokenFiat: 100000,
                        buyToken: "unlimited",
                        swapToken: "unlimited",
                        sendToken: 100000,
                        receiveToken: "unlimited",
                    },
                },
                bankDetails: {
                    create: [
                        {
                            bankName: "GTBank",
                            accountName: "Test User",
                            accountNumber: "0123456789",
                        },
                    ],
                },
            },
        });

        await prisma.recoveryEmailVerificationRequest.upsert({
            where: {
                userId: testUser.id,
            },
            update: { code: generateVerificationCode() },
            create: {
                userId: testUser.id,
                email: "testuser.recovery@flipxer.com",
                code: generateVerificationCode(),
                isVerified: true,
            },
        });

        logger.info("Test user created - Email: testuser@flipxer.com, Password: TestUser@2024!");
    }


    // Seed SYSTEM USERS (Platform & Fee Accounts)
    logger.info("Seeding System Users (Platform & Fee Accounts)...");
    const adminRoleForSystem = await prisma.role.findFirst({ where: { slug: "super-admin" } });

    if (adminRoleForSystem) {
        // Platform User (ID 0)
        await prisma.user.upsert({
            where: { id: 0 },
            update: {},
            create: {
                id: 0,
                email: "platform@system.internal",
                phone: "+00000000000",
                identifier: "SYSTEM_PLATFORM",
                firstName: "System",
                lastName: "Platform",
                userType: UserType.ADMIN,
                roleId: adminRoleForSystem.id,
                status: "ACTIVE",
                isEmailVerified: true,
                isPhoneVerified: true,
                password: process.env.SYSTEM_PLATFORM_PASSWORD || crypto.randomUUID(),
            }
        });
        logger.info("Platform User (ID 0) ensured.");

        // Network Fee User (ID -1)
        await prisma.user.upsert({
            where: { id: -1 },
            update: {},
            create: {
                id: -1,
                email: "fees@system.internal",
                phone: "+00000000001",
                identifier: "SYSTEM_FEES",
                firstName: "System",
                lastName: "Fees",
                userType: UserType.ADMIN,
                roleId: adminRoleForSystem.id,
                status: "ACTIVE",
                isEmailVerified: true,
                isPhoneVerified: true,
                password: process.env.SYSTEM_FEES_PASSWORD || crypto.randomUUID(),
            }
        });
        logger.info("Network Fee User (ID -1) ensured.");
    } else {
        logger.error("Super-admin role not found, skipping System User seeding.");
    }

    logger.info("Database seeding completed");
}

main()
    .then(() => {
        logger.info("Database seeding successful");
    })
    .catch((err) => {
        logger.error(`Database seeding failed: ${err}`);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });