import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
    datasources: {
        db: {
            url: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/staging_db'
        }
    }
});

async function verifyStaging() {
    console.log('🔌 Connecting to Staging DB...');
    try {
        await prisma.$connect();
        console.log('✅ Connected successfully');

        const userCount = await prisma.user.count();
        console.log(`📊 Current User Count: ${userCount}`);

        const ledgerCount = await prisma.ledgerEntry.count();
        console.log(`📒 Current Ledger Entries: ${ledgerCount}`);

        console.log('✅ Staging environment is ready for verification tests');
    } catch (error) {
        console.error('❌ Connection failed:', error);
        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

verifyStaging();
