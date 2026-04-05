const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  try {
    // Check all RECEIVE orders
    console.log('=== ALL RECEIVE ORDERS ===');
    const receiveOrders = await prisma.order.findMany({
      where: { orderCategory: 'RECEIVE' },
      orderBy: { createdAt: 'desc' },
      take: 20
    });
    console.log('Total RECEIVE orders:', receiveOrders.length);
    receiveOrders.forEach(o => {
      console.log(`- UserId: ${o.userId}, Amount: ${o.amount} ${o.currency}, Status: ${o.status}, Created: ${o.createdAt}`);
    });

    // Check all orders for test user (user 6)
    console.log('\n=== ALL ORDERS FOR USER 6 ===');
    const userOrders = await prisma.order.findMany({
      where: { userId: 6 },
      orderBy: { createdAt: 'desc' }
    });
    console.log('Total orders for user 6:', userOrders.length);
    userOrders.forEach(o => {
      console.log(`- [${o.orderCategory}] ${o.amount || o.volume} ${o.currency || o.fromCurrency} | Status: ${o.status} | ProviderOrderId: ${o.providerOrderId} | Created: ${o.createdAt}`);
    });

    // Check the asset wallets
    console.log('\n=== ASSET WALLETS FOR USER 6 ===');
    const wallets = await prisma.assetWallet.findMany({
      where: { userId: 6 }
    });
    wallets.forEach(w => {
      console.log(`- ${w.assetSymbol || w.assetCurrency}: Balance = ${w.balance}, Available = ${w.availableBalance}`);
    });

    // Check crypto wallet addresses for user 6
    console.log('\n=== CRYPTO WALLET ADDRESSES FOR USER 6 ===');
    const addresses = await prisma.cryptoWalletAddress.findMany({
      where: { userId: 6 }
    });
    console.log('Total addresses:', addresses.length);
    addresses.forEach(a => {
      console.log(`- ${a.assetSymbol} (${a.network}): ${a.address?.substring(0, 20)}... | WalletAddressId: ${a.walletAddressId}`);
    });

  } catch (e) {
    console.error('Error:', e);
  } finally {
    await prisma.$disconnect();
  }
}

main();
