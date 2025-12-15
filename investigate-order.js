
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

const prisma = new PrismaClient();
const QUIDAX_SECRET_KEY = process.env.QUIDAX_API_SECRET;

async function main() {
  const transactionId = '7CBGCDFE8H70DG4';
  
  console.log(`Investigating transaction: ${transactionId}`);

  const order = await prisma.order.findFirst({
    where: { transactionId: transactionId },
    include: { user: true }
  });

  if (!order) {
    console.log('Order not found in database');
    return;
  }

  console.log('Order found:', {
    id: order.id,
    status: order.status,
    providerOrderId: order.providerOrderId,
    currency: order.currency,
    amount: order.amount,
    userId: order.userId,
    userEmail: order.user.email,
    cryptoSubAccountId: order.user.cryptoSubAccountId
  });

  if (!order.providerOrderId) {
    console.log('No providerOrderId found on order');
    return;
  }

  if (!QUIDAX_SECRET_KEY) {
    console.log('QUIDAX_API_SECRET not found in environment');
    // return; // Continue to check wallet even if key is missing
  }

  // Check AssetWallet
  const wallet = await prisma.assetWallet.findUnique({
    where: {
        userId_assetCurrency: {
            userId: order.userId,
            assetCurrency: order.currency
        }
    }
  });

  console.log('Asset Wallet in DB:', wallet);

  // Check last 5 orders
  const orders = await prisma.order.findMany({
    where: { userId: order.userId },
    orderBy: { createdAt: 'desc' },
    take: 5
  });
  console.log('Last 5 orders:', orders.map(o => ({ id: o.id, type: o.orderCategory, amount: o.amount, status: o.status, createdAt: o.createdAt })));

  try {
    // For deposits, the providerOrderId is usually the deposit ID
    console.log(`Fetching deposit details from Quidax for ID: ${order.providerOrderId}`);
    
    const response = await axios.get(
      `https://app.quidax.io/api/v1/users/${order.user.cryptoSubAccountId}/deposits/${order.providerOrderId}`,
      {
        headers: {
          'Authorization': `Bearer ${QUIDAX_SECRET_KEY}`
        }
      }
    );

    console.log('Quidax Response:', JSON.stringify(response.data, null, 2));
    
    const deposit = response.data.data;
    console.log('Deposit Status on Quidax:', deposit.status);
    
    if (deposit.status !== order.status) {
        console.log('MISMATCH DETECTED!');
        console.log(`DB Status: ${order.status}`);
        console.log(`Quidax Status: ${deposit.status}`);
    } else {
        console.log('Status matches.');
    }

  } catch (error) {
    console.error('Error fetching from Quidax:', error.response ? error.response.data : error.message);
  }
}

main()
  .catch(e => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });
