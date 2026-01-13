import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const entries = await prisma.ledgerEntry.findMany({
    select: {
      userId: true,
      currency: true,
      type: true,
      credit: true,
      debit: true,
      sweepStatus: true,
      status: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  console.log('\n=== Ledger Entries ===\n');
  console.table(entries.map(e => ({
    userId: e.userId,
    currency: e.currency,
    type: e.type,
    credit: e.credit.toString(),
    sweepStatus: e.sweepStatus ?? 'NULL',
    status: e.status,
  })));

  // Count by sweep status
  const pending = entries.filter(e => e.sweepStatus === 'PENDING').length;
  const completed = entries.filter(e => e.sweepStatus === 'COMPLETED').length;
  const nullStatus = entries.filter(e => e.sweepStatus === null).length;

  console.log(`\nSweep Status Summary:`);
  console.log(`  PENDING: ${pending}`);
  console.log(`  COMPLETED: ${completed}`);
  console.log(`  NULL (no sweep needed): ${nullStatus}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
