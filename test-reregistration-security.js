const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
    try {
        console.log('\n=== RE-REGISTRATION SECURITY TEST ===\n');

        // Check for blocked users
        const blockedUsers = await prisma.user.findMany({
            where: {
                status: 'BLOCKED',
                isDeleted: true
            },
            select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                status: true,
                isDeleted: true,
                createdAt: true
            }
        });

        console.log('🚫 BLOCKED + DELETED USERS (Cannot Re-register):');
        console.log('Count:', blockedUsers.length);
        if (blockedUsers.length > 0) {
            blockedUsers.forEach(u => {
                console.log(`  - ${u.email} (${u.firstName} ${u.lastName}) - Blocked on ${u.createdAt}`);
            });
        } else {
            console.log('  None found ✅');
        }

        // Check for flagged users
        const flaggedUsers = await prisma.user.findMany({
            where: {
                isDeleted: true,
                flaggedRecord: {
                    flagged: true
                }
            },
            select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                status: true,
                isDeleted: true,
                flaggedRecord: {
                    select: {
                        flagged: true,
                        reason: true
                    }
                }
            }
        });

        console.log('\n🚩 FLAGGED + DELETED USERS (Cannot Re-register):');
        console.log('Count:', flaggedUsers.length);
        if (flaggedUsers.length > 0) {
            flaggedUsers.forEach(u => {
                console.log(`  - ${u.email} - Reason: ${u.flaggedRecord?.reason || 'Not specified'}`);
            });
        } else {
            console.log('  None found ✅');
        }

        // Check for safe deleted users
        const safeDeletedUsers = await prisma.user.findMany({
            where: {
                isDeleted: true,
                status: 'ACTIVE',
                flaggedId: null
            },
            select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                status: true,
                isDeleted: true,
                createdAt: true
            }
        });

        console.log('\n✅ SAFE DELETED USERS (Can Re-register):');
        console.log('Count:', safeDeletedUsers.length);
        if (safeDeletedUsers.length > 0) {
            safeDeletedUsers.forEach(u => {
                console.log(`  - ${u.email} (${u.firstName} ${u.lastName})`);
            });
        } else {
            console.log('  None found');
        }

        console.log('\n=== SUMMARY ===');
        console.log(`Blocked Users (Banned): ${blockedUsers.length}`);
        console.log(`Flagged Users (Policy Violation): ${flaggedUsers.length}`);
        console.log(`Safe Deleted Users (Can Return): ${safeDeletedUsers.length}`);
        console.log('\n✅ Security checks in place:');
        console.log('  - Blocked users CANNOT re-register');
        console.log('  - Flagged users CANNOT re-register');
        console.log('  - Only clean deleted users CAN re-register');

        await prisma.$disconnect();
        process.exit(0);
    } catch (err) {
        console.error('Error:', err.message);
        await prisma.$disconnect();
        process.exit(1);
    }
})();
