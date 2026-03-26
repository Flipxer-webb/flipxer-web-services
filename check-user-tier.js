const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const prisma = new PrismaClient();

async function main() {
    try {
        const user = await prisma.user.findFirst({
            where: { email: 'magpiep18@gmail.com' },
            select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                tier: true,
                isEmailVerified: true,
                isPhoneVerified: true,
                isBvnVerified: true,
                isDocumentVerified: true,
                isAddressVerified: true,
                isIncomeVerified: true,
                documentVerificationStatus: true,
            },
        });

        if (!user) {
            console.log('User not found');
            return;
        }

        console.log('User Data:');
        console.log(JSON.stringify(user, null, 2));

        // Check if they qualify for Tier 1
        const qualifiesForTier1 = user.isBvnVerified && user.isDocumentVerified;
        console.log('\nTier 1 Requirements:');
        console.log(`  BVN Verified: ${user.isBvnVerified}`);
        console.log(`  Document Verified: ${user.isDocumentVerified}`);
        console.log(`  Qualifies for Tier 1: ${qualifiesForTier1}`);

    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await prisma.$disconnect();
    }
}

main();
