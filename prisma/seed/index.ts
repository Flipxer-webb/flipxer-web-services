import {
    Prisma,
    PrismaClient,
    TransactionFeeCategory,
    UserType,
} from "@prisma/client";
import logger from "moment-logger"; // Assuming this is your custom logger
import { roles } from "./role"; // Assumed roles array file
import * as bcrypt from "bcryptjs";
import { banks } from "./bank";

const prisma = new PrismaClient();
const SALT_ROUNDS = 10; // Number of salt rounds for bcrypt hashing

async function main() {
    // const currencies = ["BTC", "USDT", "USDC"];
    // const feeCategories = Object.values(TransactionFeeCategory);
    // for (const category of feeCategories) {
    //     for (const currency of currencies) {
    //         await prisma.transactionFee.upsert({
    //             where: {
    //                 category_currency: {
    //                     category,
    //                     currency: currency.toUpperCase(),
    //                 },
    //             },
    //             update: {},
    //             create: {
    //                 category,
    //                 currency: currency.toUpperCase(),
    //                 fee: 0.5, // default fee
    //             },
    //         });
    //     }
    // }
    // for (const currency of currencies) {
    //     await prisma.cryptoRate.upsert({
    //         where: { currency },
    //         update: {},
    //         create: {
    //             currency,
    //             buyRate: 1500, // default buy rate
    //             sellRate: 1500, // default sell rate
    //         },
    //     });
    // }
    // for (let bank of banks) {
    //     await prisma.bank.upsert({
    //         where: { slug: bank.slug },
    //         update: {},
    //         create: bank,
    //     });
    // }
    // // Seed roles
    // for (let role of roles) {
    //     await prisma.role.upsert({
    //         where: { slug: role.slug },
    //         update: {},
    //         create: role,
    //     });
    // }
    // // Seed ADMIN user with recoveryEmail
    // const adminRole = await prisma.role.findUnique({
    //     where: { slug: "super-admin" },
    // });
    // if (adminRole) {
    //     const plainAdminPassword = "pass123"; // Plaintext password for admin
    //     const hashedAdminPassword = await bcrypt.hash(
    //         plainAdminPassword,
    //         SALT_ROUNDS
    //     );
    //     const createAdminOptions: Prisma.UserUncheckedCreateInput = {
    //         email: "admin@resolve.com",
    //         phone: "09010000000",
    //         userType: UserType.ADMIN,
    //         identifier: "8jhPCbsdSKxKwfgi",
    //         password: hashedAdminPassword, // Hashed password
    //         roleId: adminRole.id,
    //         firstName: "Resolve",
    //         lastName: "Admin",
    //         recoveryEmail: {
    //             create: {
    //                 recoveryEmail: "admin.recovery@resolve.com", // Recovery email for admin
    //                 lastPinGeneratedAt: null, // Initially no PIN generated
    //                 recoveryPin: null, // Initially no PIN
    //             },
    //         },
    //     };
    //     await prisma.user.upsert({
    //         where: { email: createAdminOptions.email },
    //         update: {},
    //         create: createAdminOptions,
    //     });
    // }
    // // Seed an INDIVIDUAL user with accountLimit, bankDetails, and recoveryEmail
    // const individualRole = await prisma.role.findUnique({
    //     where: { slug: "individual" },
    // });
    // if (individualRole) {
    //     const plainIndividualPassword = "pass123"; // Plaintext password for individual
    //     const hashedIndividualPassword = await bcrypt.hash(
    //         plainIndividualPassword,
    //         SALT_ROUNDS
    //     );
    //     const createIndividualOptions: Prisma.UserUncheckedCreateInput = {
    //         email: "john.doe@example.com",
    //         phone: "09032000001",
    //         userType: UserType.INDIVIDUAL,
    //         identifier: "Indv12345",
    //         password: hashedIndividualPassword, // Hashed password
    //         roleId: individualRole.id,
    //         firstName: "John",
    //         lastName: "Doe",
    //         recoveryEmail: {
    //             create: {
    //                 recoveryEmail: "john.recovery@example.com", // Recovery email for individual
    //                 lastPinGeneratedAt: null, // Initially no PIN generated
    //                 recoveryPin: null, // Initially no PIN
    //             },
    //         },
    //         accountLimit: {
    //             create: {
    //                 sellTokenFiat: 50000,
    //                 buyToken: "unlimited",
    //                 swapToken: "unlimited",
    //                 sendToken: 50000,
    //                 receiveToken: "unlimited",
    //             },
    //         },
    //         bankDetails: {
    //             create: [
    //                 {
    //                     bankName: "First Bank",
    //                     accountName: "John Doe",
    //                     accountNumber: "1234567890",
    //                 },
    //             ],
    //         },
    //     };
    //     await prisma.user.upsert({
    //         where: { email: createIndividualOptions.email },
    //         update: {},
    //         create: createIndividualOptions,
    //     });
    // }
    // // Seed a BUSINESS user with accountLimit, bankDetails, and recoveryEmail
    // const businessRole = await prisma.role.findUnique({
    //     where: { slug: "business" },
    // });
    // if (businessRole) {
    //     const plainBusinessPassword = "pass123"; // Plaintext password for business
    //     const hashedBusinessPassword = await bcrypt.hash(
    //         plainBusinessPassword,
    //         SALT_ROUNDS
    //     );
    //     const createBusinessOptions: Prisma.UserUncheckedCreateInput = {
    //         email: "acme.corp@example.com",
    //         phone: "09033000002",
    //         userType: UserType.BUSINESS,
    //         identifier: "Biz67890",
    //         password: hashedBusinessPassword, // Hashed password
    //         roleId: businessRole.id,
    //         firstName: "Acme",
    //         lastName: "Corp",
    //         recoveryEmail: {
    //             create: {
    //                 recoveryEmail: "acme.recovery@example.com", // Recovery email for business
    //                 lastPinGeneratedAt: null, // Initially no PIN generated
    //                 recoveryPin: null, // Initially no PIN
    //             },
    //         },
    //         accountLimit: {
    //             create: {
    //                 sellTokenFiat: 50000,
    //                 buyToken: "unlimited",
    //                 swapToken: "unlimited",
    //                 sendToken: 50000,
    //                 receiveToken: "unlimited",
    //             },
    //         },
    //         bankDetails: {
    //             create: [
    //                 {
    //                     bankName: "GTBank",
    //                     accountName: "Acme Corp",
    //                     accountNumber: "0987654321",
    //                 },
    //                 {
    //                     bankName: "Zenith Bank",
    //                     accountName: "Acme Corp",
    //                     accountNumber: "1122334455",
    //                 },
    //             ],
    //         },
    //     };
    //     await prisma.user.upsert({
    //         where: { email: createBusinessOptions.email },
    //         update: {},
    //         create: createBusinessOptions,
    //     });
    // }
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
