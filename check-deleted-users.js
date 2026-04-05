const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
    try {
        // Check for soft-deleted users (recoverable)
        const softDeleted = await prisma.user.findMany({
            where: { isDeleted: true },
            select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                createdAt: true,
                isEmailVerified: true
            }
        });

        console.log('\n=== SOFT DELETED USERS (Recoverable) ===');
        console.log('Count:', softDeleted.length);
        if (softDeleted.length > 0) {
            console.log(JSON.stringify(softDeleted, null, 2));
        } else {
            console.log('No soft-deleted users found.');
        }

        // Check for unverified users at risk
        const unverified = await prisma.user.findMany({
            where: {
                isDeleted: false,
                isEmailVerified: false
            },
            select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                createdAt: true
            },
            orderBy: { createdAt: 'desc' },
            take: 50
        });

        console.log('\n=== UNVERIFIED USERS (At Risk of Deletion) ===');
        console.log('Total Count:', unverified.length);
        
        if (unverified.length > 0) {
            const now = new Date();
            const atRisk = [];
            const safe = [];
            
            unverified.forEach(u => {
                const ageMs = now - new Date(u.createdAt);
                const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
                const ageHours = Math.floor(ageMs / (1000 * 60 * 60));
                
                const userInfo = {
                    email: u.email,
                    name: `${u.firstName || ''} ${u.lastName || ''}`.trim(),
                    createdAt: u.createdAt,
                    ageDays,
                    ageHours,
                    status: ageDays >= 3 ? '🚨 WILL BE DELETED TONIGHT' : '✅ Safe for now'
                };
                
                if (ageDays >= 3) {
                    atRisk.push(userInfo);
                } else {
                    safe.push(userInfo);
                }
            });

            if (atRisk.length > 0) {
                console.log('\n⚠️  USERS THAT WILL BE DELETED AT MIDNIGHT:');
                console.log('Count:', atRisk.length);
                atRisk.forEach(u => {
                    console.log(`  - ${u.email} (${u.name}) - ${u.ageDays} days old`);
                });
            }

            if (safe.length > 0) {
                console.log('\n✅ USERS STILL SAFE (< 3 days):');
                console.log('Count:', safe.length);
                safe.forEach(u => {
                    console.log(`  - ${u.email} (${u.name}) - ${u.ageDays}d ${u.ageHours % 24}h old`);
                });
            }
        }

        // Check for specific user
        console.log('\n=== CHECKING SPECIFIC USER: magpiep18@gmail.com ===');
        const specificUser = await prisma.user.findUnique({
            where: { email: 'magpiep18@gmail.com' }
        });
        
        if (specificUser) {
            console.log('✅ FOUND:', {
                email: specificUser.email,
                name: `${specificUser.firstName} ${specificUser.lastName}`,
                isDeleted: specificUser.isDeleted,
                isEmailVerified: specificUser.isEmailVerified,
                createdAt: specificUser.createdAt
            });
        } else {
            console.log('❌ NOT FOUND - User was likely permanently deleted by the cron job');
        }

        await prisma.$disconnect();
        process.exit(0);
    } catch (err) {
        console.error('Error:', err.message);
        await prisma.$disconnect();
        process.exit(1);
    }
})();
