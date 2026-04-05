import { PrismaClient, LedgerType, EntryStatus, UserType } from '@prisma/client';

const prisma = new PrismaClient({
    datasources: {
        db: {
            url: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/staging_db'
        }
    }
});

async function verifySchema() {
    console.log('🔍 Verifying Database Schema Compatibility...');
    try {
        await prisma.$connect();

        // Check if REFUND exists in the runtime enum (Prisma ensures this matches DB)
        if (LedgerType.REFUND) {
            console.log('✅ LedgerType.REFUND exists in Prisma Client');
        } else {
            console.error('❌ LedgerType.REFUND MISSING from Prisma Client');
            process.exit(1);
        }

        // Try to create a dummy entry with REFUND type to prove DB accepts it
        console.log('📝 Attempting to write test REFUND entry to Staging DB...');

        const testUser = await prisma.user.create({
            data: {
                email: `test_verify_${Date.now()}@example.com`,
                identifier: `USER-${Date.now()}`, // Required field
                password: 'hash',
                username: `verify_${Date.now()}`,
                userType: UserType.INDIVIDUAL, // Required field
                role: {
                    connectOrCreate: {
                        where: { name: 'User' },
                        create: { name: 'User', slug: 'user', description: 'Regular user' }
                    }
                }
            }
        });

        const entry = await prisma.ledgerEntry.create({
            data: {
                userId: testUser.id,
                currency: 'TEST',
                type: LedgerType.REFUND,
                debit: 0,
                credit: 0,
                balanceAfter: 0,
                status: EntryStatus.SETTLED,
                reference: `verify:refund:${Date.now()}`,
                description: 'Verification Script Test Entry'
            }
        });

        console.log(`✅ Successfully created LedgerEntry with type REFUND (ID: ${entry.id})`);

        // Cleanup
        await prisma.ledgerEntry.delete({ where: { id: entry.id } });
        await prisma.user.delete({ where: { id: testUser.id } });

        console.log('✅ Cleanup complete. Staging DB is fully compatible with fixes.');

    } catch (error) {
        console.error('❌ Schema Verification Failed:', error);
        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

verifySchema();
