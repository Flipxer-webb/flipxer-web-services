/**
 * Get AssetWallets column names
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
    const columns = await prisma.$queryRaw`
    SELECT column_name 
    FROM information_schema.columns 
    WHERE table_name = 'AssetWallets'
    ORDER BY ordinal_position
  `;
    console.log("AssetWallets columns:", columns);
    await prisma.$disconnect();
}

main();
