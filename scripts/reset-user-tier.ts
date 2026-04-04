import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    // Find user first using raw query
    const users = await prisma.$queryRaw`
    SELECT id, email, tier, "isBvnVerified", "isNinVerified", "isDocumentVerified", "isAddressVerified", "isIncomeVerified" 
    FROM "User" 
    WHERE email = 'magpiep18@gmail.com'
  `;

    console.log('Found user:', users);

    // Reset user
    const result = await prisma.$executeRaw`
    UPDATE "User" 
    SET 
      tier = 0,
      "isBvnVerified" = false,
      "isNinVerified" = false,
      "isDocumentVerified" = false,
      "isAddressVerified" = false,
      "isIncomeVerified" = false,
      bvn = NULL,
      nin = NULL
    WHERE email = 'magpiep18@gmail.com'
  `;

    console.log('Rows updated:', result);

    // Verify the update
    const updated = await prisma.$queryRaw`
    SELECT id, email, tier, "isBvnVerified", "isNinVerified", "isDocumentVerified", "isAddressVerified", "isIncomeVerified" 
    FROM "User" 
    WHERE email = 'magpiep18@gmail.com'
  `;

    console.log('User after reset:', updated);
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
