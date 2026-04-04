require('dotenv').config();
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Starting...');
  try {
    // Get test user
    const user = await prisma.user.findUnique({
      where: { email: 'testuser@flipxer.com' }
    });
    
    if (!user) {
      console.log('User not found');
      return;
    }
    
    console.log('User ID:', user.id);
    console.log('Quidax SubAccount ID:', user.cryptoSubAccountId);
    
    // Fetch deposits from Quidax
    const baseUrl = process.env.QUIDAX_BASE_URL || 'https://www.quidax.com/api';
    const secretKey = process.env.QUIDAX_API_SECRET;
    
    if (!secretKey) {
      console.log('QUIDAX_API_SECRET not configured');
      return;
    }
    
    console.log('\nBase URL:', baseUrl);
    
    console.log('\n=== FETCHING USDT DEPOSITS FROM QUIDAX ===');
    const response = await axios.get(
      `${baseUrl}/users/${user.cryptoSubAccountId}/wallets/usdt/deposits`,
      {
        headers: {
          'Authorization': `Bearer ${secretKey}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    if (response.data?.status === 'success' && response.data?.data) {
      const deposits = response.data.data;
      console.log('Total USDT deposits from Quidax:', deposits.length);
      
      deposits.forEach((dep, i) => {
        console.log(`\n--- Deposit ${i + 1} ---`);
        console.log('ID:', dep.id);
        console.log('Amount:', dep.amount);
        console.log('Fee:', dep.fee);
        console.log('Status:', dep.status);
        console.log('Type:', dep.type);
        console.log('TxID:', dep.txid);
        console.log('Payment Address:', dep.payment_address?.address);
        console.log('Payment Address ID:', dep.payment_address?.id);
        console.log('Network:', dep.payment_address?.network);
        console.log('Created At:', dep.created_at);
        console.log('Done At:', dep.done_at);
      });
    } else {
      console.log('Response:', JSON.stringify(response.data, null, 2));
    }
    
    // Check all wallets with deposits
    console.log('\n=== CHECKING ALL WALLET BALANCES FROM QUIDAX ===');
    const walletsResponse = await axios.get(
      `${baseUrl}/users/${user.cryptoSubAccountId}/wallets`,
      {
        headers: {
          'Authorization': `Bearer ${secretKey}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    if (walletsResponse.data?.status === 'success' && walletsResponse.data?.data) {
      const wallets = walletsResponse.data.data;
      wallets.forEach(w => {
        if (parseFloat(w.balance) > 0 || parseFloat(w.locked) > 0) {
          console.log(`- ${w.currency.toUpperCase()}: Balance = ${w.balance}, Locked = ${w.locked}`);
        }
      });
    }
    
  } catch (e) {
    console.error('Error:', e.response?.data || e.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
