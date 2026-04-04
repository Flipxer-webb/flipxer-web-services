import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const roles = await prisma.role.findMany();
  console.log('Roles found:', roles.length);
  roles.forEach(r => console.log(`  - ${r.slug} (ID: ${r.id})`));
  
  const banks = await prisma.bank.count();
  console.log('\nBanks found:', banks);
  
  const fees = await prisma.transactionFee.count();
  console.log('Transaction fees found:', fees);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
