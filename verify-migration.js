const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function verifyMigration() {
    console.log('🔍 Verifying backup codes migration...\n');
    
    try {
        // Check if the column exists
        const result = await prisma.$queryRaw`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'Users' 
            AND column_name = 'twoFactorBackupCodes';
        `;
        
        if (result.length > 0) {
            console.log('✅ Column exists:', result[0]);
        } else {
            console.log('❌ Column not found');
        }
        
        // Check if users can be queried with the new field
        const user = await prisma.user.findFirst({
            select: {
                id: true,
                email: true,
                twoFactorBackupCodes: true,
                isTwoFactorEnabled: true,
            }
        });
        
        console.log('\n✅ Successfully queried user with new field');
        console.log('Sample user:', {
            id: user?.id,
            email: user?.email,
            hasTwoFactor: user?.isTwoFactorEnabled,
            hasBackupCodes: !!user?.twoFactorBackupCodes
        });
        
        console.log('\n✨ Migration verified successfully!');
    } catch (error) {
        console.error('❌ Verification failed:', error.message);
    } finally {
        await prisma.$disconnect();
    }
}

verifyMigration();
