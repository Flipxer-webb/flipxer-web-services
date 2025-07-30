import { PrismaClient, UserType, TransactionFeeCategory } from "@prisma/client";
import logger from "moment-logger"; // Assuming this is your custom logger
import * as bcrypt from "bcryptjs";
import { customAlphabet } from "nanoid"; // For generating verification codes
import { roles } from "./role"; // Assumed roles array file

const prisma = new PrismaClient();
const SALT_ROUNDS = 10; // Number of salt rounds for bcrypt hashing

async function main() {
    logger.info("Starting database seeding...");

    // Seed roles
    logger.info("Seeding roles...");
    const currencies = ["BTC", "USDT", "USDC"];
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
    for (const currency of currencies) {
        await prisma.cryptoRate.upsert({
            where: { currency },
            update: {},
            create: {
                currency,
                buyRate: 0.0, // default buy rate
                sellRate: 0.0, // default sell rate
            },
        });
    }

    // Seed roles
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
        const plainAdminPassword = "pass123";
        const hashedAdminPassword = await bcrypt.hash(
            plainAdminPassword,
            SALT_ROUNDS
        );
        const admin = await prisma.user.upsert({
            where: { email: "admin@resolve.com" },
            update: {},
            create: {
                email: "admin@resolve.com",
                phone: "09010000000",
                userType: UserType.ADMIN,
                identifier: "8jhPCbsdSKxKwfgi",
                password: hashedAdminPassword,
                roleId: adminRole.id,
                firstName: "Resolve",
                lastName: "Admin",
                recoveryEmail: "admin.recovery@resolve.com",
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
                            accountName: "Resolve Admin",
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
                email: "admin.recovery@resolve.com",
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
        const plainIndividualPassword = "pass123";
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
        const plainChidiPassword = "pass123";
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

    // Seed BUSINESS user (Acme Corp)
    logger.info("Seeding Acme Corp user...");
    const businessRole = await prisma.role.findUnique({
        where: { slug: "business" },
    });
    if (businessRole) {
        const plainBusinessPassword = "pass123";
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
