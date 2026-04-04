const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function addMissing2FAColumns() {
    console.log('🔄 Adding missing 2FA columns...\n');
    
    try {
        // Add isTwoFactorEnabled column
        await prisma.$executeRawUnsafe(`
            ALTER TABLE "Users" 
            ADD COLUMN IF NOT EXISTS "isTwoFactorEnabled" BOOLEAN DEFAULT false;
        `);
        console.log('✅ Added isTwoFactorEnabled column');

        // Add twoFactorSecret column
        await prisma.$executeRawUnsafe(`
            ALTER TABLE "Users" 
            ADD COLUMN IF NOT EXISTS "twoFactorSecret" TEXT;
        `);
        console.log('✅ Added twoFactorSecret column');

        // Verify all columns exist
        const result = await prisma.$queryRaw`
            SELECT column_name, data_type, column_default
            FROM information_schema.columns 
            WHERE table_name = 'Users' 
            AND column_name IN ('isTwoFactorEnabled', 'twoFactorSecret', 'twoFactorBackupCodes')
            ORDER BY column_name;
        `;
        
        console.log('\n📊 2FA Columns in database:');
        result.forEach(col => {
            console.log(`  - ${col.column_name}: ${col.data_type} ${col.column_default || ''}`);
        });

        console.log('\n✨ All 2FA columns added successfully!');
    } catch (error) {
        console.error('❌ Failed:', error.message);
    } finally {
        await prisma.$disconnect();
    }
}

addMissing2FAColumns();
