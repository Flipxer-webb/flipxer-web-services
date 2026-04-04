import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      userType: true,
      status: true,
      createdAt: true,
    },
  });

  console.log('Total users:', users.length);
  
  const admins = users.filter(u => u.userType === 'ADMIN');
  const individuals = users.filter(u => u.userType === 'INDIVIDUAL');
  const businesses = users.filter(u => u.userType === 'BUSINESS');

  console.log('\n=== ADMINS (' + admins.length + ') ===');
  admins.forEach(u => console.log(`  ${u.id} | ${u.email} | ${u.firstName} ${u.lastName} | ${u.status}`));

  console.log('\n=== INDIVIDUAL USERS (' + individuals.length + ') ===');
  individuals.forEach(u => console.log(`  ${u.id} | ${u.email} | ${u.firstName} ${u.lastName} | ${u.status}`));

  console.log('\n=== BUSINESS USERS (' + businesses.length + ') ===');
  businesses.forEach(u => console.log(`  ${u.id} | ${u.email} | ${u.firstName} ${u.lastName} | ${u.status}`));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
