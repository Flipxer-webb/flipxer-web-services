
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
    console.log("=== Database Tables ===");
    const tables = await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public'
    ORDER BY table_name
  `;

    tables.forEach(t => console.log(`- ${t.table_name}`));
    console.log(`\nTotal: ${tables.length} tables`);

    // Check _prisma_migrations for ledger migrations
    console.log("\n=== Applied Migrations (last 5) ===");
    const migrations = await prisma.$queryRaw<{ migration_name: string, finished_at: Date }[]>`
    SELECT migration_name, finished_at 
    FROM _prisma_migrations 
    ORDER BY finished_at DESC 
    LIMIT 5
  `;
    migrations.forEach(m => console.log(`- ${m.migration_name} (${m.finished_at})`));

    await prisma.$disconnect();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
