
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
    try {
        console.log("Checking for LedgerEntry table...");
        // Raw query to check if table exists in postgres
        const tableCheck = await prisma.$queryRaw`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE  table_schema = 'public'
        AND    table_name   = 'LedgerEntry'
      );
    `;
        console.log("Table 'LedgerEntry' exists:", tableCheck);

        if (Array.isArray(tableCheck) && tableCheck[0]?.exists) {
            console.log("Table found. Checking for SWEEP entries...");
            try {
                const sweeps = await prisma.$queryRaw`SELECT * FROM "LedgerEntry" WHERE type = 'SWEEP' ORDER BY "createdAt" DESC LIMIT 5`;
                console.log("Recemt Sweep Entries:", sweeps);
            } catch (e) {
                console.log("Could not query LedgerEntry rows:", e.message);
            }
        } else {
            console.log("LedgerEntry table does NOT exist.");
        }

    } catch (error) {
        console.error("Error executing raw query:", error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
