/**
 * Test Script for Enhanced 2FA Features
 * Run: node test-2fa-enhancements.js
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function testEnhancements() {
    console.log('🧪 Testing Enhanced 2FA Implementation...\n');

    try {
        // Test 1: Check database schema
        console.log('📊 Test 1: Database Schema');
        const userWithBackupCodes = await prisma.user.findFirst({
            where: { isTwoFactorEnabled: true },
            select: {
                id: true,
                email: true,
                isTwoFactorEnabled: true,
                twoFactorSecret: true,
                twoFactorBackupCodes: true,
                tier: true,
            },
        });

        if (userWithBackupCodes) {
            console.log('✅ Found user with 2FA enabled:');
            console.log(`   - Email: ${userWithBackupCodes.email}`);
            console.log(`   - Tier: ${userWithBackupCodes.tier}`);
            console.log(`   - Has Secret: ${!!userWithBackupCodes.twoFactorSecret}`);
            console.log(`   - Has Backup Codes: ${!!userWithBackupCodes.twoFactorBackupCodes}`);
            
            if (userWithBackupCodes.twoFactorBackupCodes) {
                try {
                    const codes = JSON.parse(userWithBackupCodes.twoFactorBackupCodes);
                    console.log(`   - Backup Codes Count: ${codes.length}`);
                } catch (e) {
                    console.log('   ⚠️  Invalid JSON in backup codes field');
                }
            }
        } else {
            console.log('ℹ️  No users with 2FA enabled found');
        }

        // Test 2: Check crypto rates for tier thresholds
        console.log('\n💱 Test 2: Crypto Rates (for tier threshold conversion)');
        const rates = await prisma.cryptoRate.findMany({
            where: {
                asset: { in: ['BTC', 'USDT', 'ETH'] },
            },
            select: {
                asset: true,
                buyRate: true,
                createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
            take: 3,
        });

        if (rates.length > 0) {
            console.log('✅ Latest crypto rates:');
            rates.forEach(rate => {
                console.log(`   - ${rate.asset}: ₦${rate.buyRate.toLocaleString()}`);
                
                // Calculate tier thresholds
                const tier1Threshold = 50000;
                const tier2Threshold = 100000;
                const tier3Threshold = 500000;
                
                console.log(`     Tier 1 (₦50k): ${(tier1Threshold / rate.buyRate).toFixed(8)} ${rate.asset}`);
                console.log(`     Tier 2 (₦100k): ${(tier2Threshold / rate.buyRate).toFixed(8)} ${rate.asset}`);
                console.log(`     Tier 3 (₦500k): ${(tier3Threshold / rate.buyRate).toFixed(8)} ${rate.asset}`);
            });
        } else {
            console.log('⚠️  No crypto rates found');
        }

        // Test 3: User tier distribution
        console.log('\n👥 Test 3: User Tier Distribution');
        const tierDistribution = await prisma.user.groupBy({
            by: ['tier'],
            _count: true,
            orderBy: { tier: 'asc' },
        });

        console.log('✅ Tier distribution:');
        tierDistribution.forEach(t => {
            const thresholds = {
                0: '₦0 (all transactions)',
                1: '₦50,000',
                2: '₦100,000',
                3: '₦500,000',
            };
            console.log(`   - Tier ${t.tier}: ${t._count} users (2FA required for ≥ ${thresholds[t.tier] || 'Unknown'})`);
        });

        // Test 4: 2FA adoption rate
        console.log('\n🔐 Test 4: 2FA Adoption Rate');
        const totalUsers = await prisma.user.count();
        const users2FAEnabled = await prisma.user.count({
            where: { isTwoFactorEnabled: true },
        });

        console.log('✅ 2FA Statistics:');
        console.log(`   - Total Users: ${totalUsers}`);
        console.log(`   - Users with 2FA: ${users2FAEnabled}`);
        console.log(`   - Adoption Rate: ${((users2FAEnabled / totalUsers) * 100).toFixed(2)}%`);

        console.log('\n✅ All tests completed successfully!');
        console.log('\n📝 Next Steps:');
        console.log('   1. Apply migration: npx prisma migrate deploy');
        console.log('   2. Test 2FA setup endpoint to generate backup codes');
        console.log('   3. Test rate limiting with failed attempts');
        console.log('   4. Test tier-based transaction thresholds');
        console.log('   5. Update frontend to display backup codes with warning');

    } catch (error) {
        console.error('❌ Test failed:', error.message);
        console.error(error);
    } finally {
        await prisma.$disconnect();
    }
}

testEnhancements();
