const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  try {
    // Find the test user
    const user = await prisma.user.findUnique({
      where: { email: 'testuser@flipxer.com' },
      include: {
        order: {
          orderBy: { createdAt: 'desc' },
          take: 30
        },
        assetWallets: true,
        payments: {
          orderBy: { createdAt: 'desc' },
          take: 30
        }
      }
    });

    console.log('=== USER INFO ===');
    console.log('User ID:', user?.id);
    console.log('User Name:', user?.firstName, user?.lastName);
    console.log('Email:', user?.email);
    console.log('Crypto SubAccount ID:', user?.cryptoSubAccountId);

    console.log('\n=== ASSET WALLETS ===');
    if (user?.assetWallets) {
      for (const wallet of user.assetWallets) {
        if (parseFloat(wallet.balance) > 0 || parseFloat(wallet.availableBalance) > 0) {
          console.log(`- ${wallet.assetSymbol}: Balance = ${wallet.balance}, Available = ${wallet.availableBalance}`);
        }
      }
    }

    console.log('\n=== ORDERS (ALL) ===');
    console.log('Total orders in DB:', user?.order?.length);
    if (user?.order) {
      for (const ord of user.order) {
        console.log(`- [${ord.orderCategory}] ${ord.amount || ord.volume} ${ord.currency || ord.fromCurrency || 'N/A'} | Status: ${ord.status} | Streamlined: ${ord.streamlinedStatus} | Created: ${ord.createdAt}`);
      }
    }

    console.log('\n=== PAYMENTS (ALL) ===');
    console.log('Total payments in DB:', user?.payments?.length);
    if (user?.payments) {
      for (const pay of user.payments) {
        console.log(`- [${pay.type}] ${pay.amount} | Status: ${pay.status} | Title: ${pay.title} | Created: ${pay.createdAt}`);
      }
    }

    // Check for DEPOSIT orders specifically
    console.log('\n=== DEPOSIT ORDERS ONLY ===');
    const depositOrders = await prisma.order.findMany({
      where: {
        userId: user?.id,
        orderCategory: 'DEPOSIT'
      },
      orderBy: { createdAt: 'desc' }
    });
    console.log('Deposit orders count:', depositOrders.length);
    depositOrders.forEach(ord => {
      console.log(`- ${ord.amount || ord.volume} ${ord.currency} | Status: ${ord.status} | ProviderOrderId: ${ord.providerOrderId} | TxId: ${ord.blockchain_txid}`);
    });

    // Check all USDT related orders
    console.log('\n=== USDT ORDERS ONLY ===');
    const usdtOrders = await prisma.order.findMany({
      where: {
        userId: user?.id,
        OR: [
          { currency: 'usdt' },
          { currency: 'USDT' },
          { fromCurrency: 'usdt' },
          { fromCurrency: 'USDT' },
          { toCurrency: 'usdt' },
          { toCurrency: 'USDT' }
        ]
      },
      orderBy: { createdAt: 'desc' }
    });
    console.log('USDT orders count:', usdtOrders.length);
    usdtOrders.forEach(ord => {
      console.log(`- [${ord.orderCategory}] ${ord.amount || ord.volume} ${ord.currency || ord.fromCurrency} -> ${ord.toCurrency || ''} | Status: ${ord.status} | Created: ${ord.createdAt}`);
    });

  } catch (e) {
    console.error('Error:', e);
  } finally {
    await prisma.$disconnect();
  }
}

main();
