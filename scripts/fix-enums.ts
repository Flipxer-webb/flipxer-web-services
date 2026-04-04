import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function fix() {
  // Add missing EntryStatus values
  await p.$executeRawUnsafe(`ALTER TYPE "EntryStatus" ADD VALUE IF NOT EXISTS 'HOLD';`);
  await p.$executeRawUnsafe(`ALTER TYPE "EntryStatus" ADD VALUE IF NOT EXISTS 'SETTLED';`);
  await p.$executeRawUnsafe(`ALTER TYPE "EntryStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';`);
  console.log('✅ Added EntryStatus values: HOLD, SETTLED, CANCELLED');
  
  // Add missing SweepStatus values  
  await p.$executeRawUnsafe(`ALTER TYPE "SweepStatus" ADD VALUE IF NOT EXISTS 'IN_PROGRESS';`);
  await p.$executeRawUnsafe(`ALTER TYPE "SweepStatus" ADD VALUE IF NOT EXISTS 'NOT_APPLICABLE';`);
  console.log('✅ Added SweepStatus values: IN_PROGRESS, NOT_APPLICABLE');
}

fix().catch(console.error).finally(() => p.$disconnect());
