
import { PrismaClient, UserType } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
    console.log("Seeding system users (Platform & Fee accounts)...");

    // 1. Get a valid role (e.g. super-admin)
    const adminRole = await prisma.role.findFirst({
        where: { slug: "super-admin" }
    });

    if (!adminRole) {
        throw new Error("Super-admin role not found. Please run the main seed first.");
    }

    // 2. Insert Platform User (ID 0)
    // We use raw SQL or updateMany because creating with specific ID might be tricky if auto-increment is on, 
    // but Prisma allows setting ID if you provide it in create.
    // However, 0 could be tricky with some DBs, but generally fine in Postgres.

    // Using upsert for Platform User
    // note: We might need to force the ID.

    const platformUser = await prisma.user.upsert({
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
            roleId: adminRole.id,
            status: "ACTIVE",
            isEmailVerified: true,
            isPhoneVerified: true,
            password: process.env.SYSTEM_PLATFORM_PASSWORD || "NO_LOGIN_ALLOWED_PLATFORM",
        }
    });

    console.log(`Platform User (ID: ${platformUser.id}) ensured.`);

    // 3. Insert Network Fee User (ID -1)
    // ID -1 is definitely special, some auto-increment sequences might not like it if we don't specify it explicitly.
    // But since `id` is Int @id @default(autoincrement()), providing it should override default.

    const feeUser = await prisma.user.upsert({
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
            roleId: adminRole.id,
            status: "ACTIVE",
            isEmailVerified: true,
            isPhoneVerified: true,
            password: process.env.SYSTEM_FEES_PASSWORD || "NO_LOGIN_ALLOWED_FEES",
        }
    });

    console.log(`Network Fee User (ID: ${feeUser.id}) ensured.`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
