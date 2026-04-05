/**
 * Script to count and list all admin users
 * Run with: npx ts-node prisma/scripts/count-admins.ts
 */

import { PrismaClient, UserType } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
    console.log("📊 Checking admin users...\n");

    // Count all admin users
    const adminCount = await prisma.user.count({
        where: { userType: UserType.ADMIN },
    });

    console.log(`👥 Total Admin Users: ${adminCount}\n`);

    // Get all admin users with their roles
    const admins = await prisma.user.findMany({
        where: { userType: UserType.ADMIN },
        select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            isEmailVerified: true,
            createdAt: true,
            role: {
                select: {
                    name: true,
                    slug: true,
                },
            },
        },
        orderBy: { createdAt: "asc" },
    });

    if (admins.length > 0) {
        console.log("📋 Admin List:\n");
        console.log("─".repeat(80));
        admins.forEach((admin, index) => {
            console.log(`${index + 1}. ${admin.email}`);
            console.log(`   Name: ${admin.firstName} ${admin.lastName}`);
            console.log(`   Role: ${admin.role?.name || "No role"} (${admin.role?.slug || "N/A"})`);
            console.log(`   Verified: ${admin.isEmailVerified ? "✅ Yes" : "❌ No"}`);
            console.log(`   Created: ${admin.createdAt.toISOString()}`);
            console.log(`   ID: ${admin.id}`);
            console.log("─".repeat(80));
        });
    } else {
        console.log("⚠️ No admin users found in the database.");
    }
}

main()
    .catch((e) => {
        console.error("❌ Error:", e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
