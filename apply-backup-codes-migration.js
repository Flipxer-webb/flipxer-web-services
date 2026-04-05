const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function applyMigration() {
    console.log('🔄 Applying backup codes migration directly...\n');
    
    try {
        // Apply the migration SQL
        await prisma.$executeRawUnsafe(`
            ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "twoFactorBackupCodes" TEXT;
        `);
        console.log('✅ Added twoFactorBackupCodes column');

        await prisma.$executeRawUnsafe(`
            COMMENT ON COLUMN "Users"."twoFactorBackupCodes" IS 'JSON array of hashed backup codes for 2FA recovery';
        `);
        console.log('✅ Added column comment');

        // Mark migration as applied in _prisma_migrations table
        await prisma.$executeRawUnsafe(`
            INSERT INTO "_prisma_migrations" 
            ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count")
            VALUES 
            (gen_random_uuid(), '${Date.now()}', NOW(), '20251219000001_add_two_factor_backup_codes', NULL, NULL, NOW(), 1)
            ON CONFLICT DO NOTHING;
        `);
        console.log('✅ Marked migration as applied');

        console.log('\n✨ Migration applied successfully!');
    } catch (error) {
        console.error('❌ Migration failed:', error.message);
        throw error;
    } finally {
        await prisma.$disconnect();
    }
}

applyMigration();
