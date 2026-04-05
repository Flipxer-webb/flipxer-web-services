const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function checkUserVerification() {
    const email = process.argv[2] || 'magpiep18@gmail.com';
    
    console.log(`\nChecking verification status for: ${email}\n`);
    
    const user = await prisma.user.findFirst({
        where: { email: email },
        select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            phone: true,
            tier: true,
            status: true,
            isEmailVerified: true,
            isPhoneVerified: true,
            isDocumentVerified: true,
            isAddressVerified: true,
            isBiometricVerified: true,
            isIncomeVerified: true,
            isBvnVerified: true,
            isNinVerified: true,
            bvn: true,
            nin: true,
            userDocument: true,
            createdAt: true,
            updatedAt: true,
        }
    });

    if (!user) {
        console.log('User not found!');
        await prisma.$disconnect();
        return;
    }

    console.log('=== USER INFO ===');
    console.log(`ID: ${user.id}`);
    console.log(`Email: ${user.email}`);
    console.log(`Name: ${user.firstName} ${user.lastName}`);
    console.log(`Phone: ${user.phone || '(empty)'}`);
    console.log(`Tier: ${user.tier}`);
    console.log(`Status: ${user.status}`);
    console.log(`Created: ${user.createdAt}`);
    console.log(`Updated: ${user.updatedAt}`);
    
    console.log('\n=== VERIFICATION STATUS ===');
    console.log(`Email Verified: ${user.isEmailVerified}`);
    console.log(`Phone Verified: ${user.isPhoneVerified}`);
    console.log(`Document Verified: ${user.isDocumentVerified}`);
    console.log(`Address Verified: ${user.isAddressVerified}`);
    console.log(`Biometric Verified: ${user.isBiometricVerified}`);
    console.log(`Income Verified: ${user.isIncomeVerified}`);
    console.log(`BVN Verified: ${user.isBvnVerified}`);
    console.log(`NIN Verified: ${user.isNinVerified}`);
    
    console.log('\n=== IDENTITY INFO ===');
    console.log(`BVN: ${user.bvn ? '****' + user.bvn.slice(-4) : '(not submitted)'}`);
    console.log(`NIN: ${user.nin ? '****' + user.nin.slice(-4) : '(not submitted)'}`);
    console.log(`Has User Document: ${!!user.userDocument}`);
    
    if (user.userDocument) {
        console.log('\n=== USER DOCUMENT ===');
        console.log(JSON.stringify(user.userDocument, null, 2));
    }
    
    // Check what tier they should be based on current logic
    console.log('\n=== TIER CALCULATION ===');
    if (!user.isEmailVerified || !user.isPhoneVerified) {
        console.log(`BLOCKED by safety check: isEmailVerified=${user.isEmailVerified}, isPhoneVerified=${user.isPhoneVerified}`);
        console.log('Cannot advance to any tier > 0 until both email AND phone are verified');
    } else {
        console.log('Passes safety check (email + phone verified)');
        if (user.isDocumentVerified) {
            console.log('Has document verified - should be Tier 1+');
        }
    }

    await prisma.$disconnect();
}

checkUserVerification().catch(async (e) => {
    console.error('Error:', e);
    await prisma.$disconnect();
    process.exit(1);
});
