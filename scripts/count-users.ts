
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
    console.log("=== Pre-Migration User Count ===");
    const userCount = await prisma.user.count();
    console.log(`Total Users: ${userCount}`);

    await prisma.$disconnect();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
