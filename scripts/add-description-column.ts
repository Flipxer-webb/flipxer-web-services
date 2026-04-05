import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "LedgerEntries" ADD COLUMN IF NOT EXISTS "description" TEXT;
  `);
  console.log('✅ Added description column to LedgerEntries');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
