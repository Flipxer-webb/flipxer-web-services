const { PrismaClient } = require('@prisma/client');

async function main() {
  const prisma = new PrismaClient();
  
  try {
    // Check user details
    const user = await prisma.user.findFirst({
      where: { id: 8 },
      select: {
        id: true,
        email: true,
        tier: true,
        identifier: true,
        isEmailVerified: true,
        isPhoneVerified: true,
        isBvnVerified: true,
        isDocumentVerified: true,
        cryptoSubAccountId: true,
      }
    });
    console.log('User:', JSON.stringify(user, null, 2));
    
    // Check asset wallets
    const wallets = await prisma.assetWallet.findMany({
      where: { userId: 8 },
      select: { id: true, assetName: true, assetCurrency: true }
    });
    console.log('Asset Wallets:', wallets.length ? JSON.stringify(wallets, null, 2) : 'NONE');
    
    // Check crypto rates
    const rates = await prisma.cryptoRate.count();
    console.log('Crypto Rates in DB:', rates);
    
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(console.error);
