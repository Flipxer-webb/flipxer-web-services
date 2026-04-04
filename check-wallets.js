const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  // Find test user by email
  const user = await prisma.user.findFirst({
    where: {
      email: 'adeleyetemiloluwa@gmail.com'
    },
    include: {
      assetWallets: true
    }
  });

  if (!user) {
    console.log('User not found');
    return;
  }

  console.log('=== User Info ===');
  console.log('ID:', user.id);
  console.log('Email:', user.email);
  console.log('Crypto SubAccount ID:', user.cryptoSubAccountId);
  
  console.log('\n=== Asset Wallets ===');
  const wallets = user.assetWallets || [];
  console.log('Total asset wallets:', wallets.length);
  
  wallets.forEach(wallet => {
    console.log(`\nWallet: ${wallet.id}`);
    console.log('  Currency:', wallet.assetCurrency);
    console.log('  Balance:', wallet.balance);
    console.log('  Network:', wallet.defaultNetwork);
  });

  // Check if there are any users with crypto subaccount
  console.log('\n=== Users with Crypto SubAccount ===');
  const usersWithCrypto = await prisma.user.findMany({
    where: {
      cryptoSubAccountId: { not: null }
    },
    take: 5,
    select: {
      id: true,
      email: true,
      cryptoSubAccountId: true
    }
  });
  console.log('Users with crypto subAccountId:', usersWithCrypto.length);
  usersWithCrypto.forEach(u => {
    console.log(`  - ${u.email}: ${u.cryptoSubAccountId}`);
  });
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
