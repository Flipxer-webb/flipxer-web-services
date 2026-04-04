// Check if user has cryptoSubAccountId stored
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

async function run() {
    const prisma = new PrismaClient();
    
    const user = await prisma.user.findFirst({
        where: { email: 'testuser@flipxer.com' },
        select: { 
            id: true, 
            email: true, 
            firstName: true,
            lastName: true,
            cryptoSubAccountId: true 
        }
    });
    
    console.log('User in DB:');
    console.log(JSON.stringify(user, null, 2));
    
    if (user && !user.cryptoSubAccountId) {
        console.log('\n⚠️  User does NOT have cryptoSubAccountId stored!');
        console.log('The Quidax account exists but is not linked to the user.');
    } else if (user && user.cryptoSubAccountId) {
        console.log('\n✓ User has cryptoSubAccountId:', user.cryptoSubAccountId);
    }
    
    // Also check for AssetWallet records
    if (user) {
        const wallets = await prisma.assetWallet.findMany({
            where: { userId: user.id },
            select: { id: true, symbol: true, balance: true }
        });
        console.log('\nAssetWallet records for user:', wallets.length);
        wallets.forEach(w => console.log(`- ${w.symbol}: ${w.balance}`));
    }
    
    await prisma.$disconnect();
}

run().catch(console.error);
