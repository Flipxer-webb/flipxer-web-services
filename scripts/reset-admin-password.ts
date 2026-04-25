/**
 * Script to reset admin password in production database
 * 
 * Usage:
 *   DATABASE_URL="postgresql://..." npx ts-node scripts/reset-admin-password.ts
 * 
 * Or set the DATABASE_URL environment variable and run:
 *   npx ts-node scripts/reset-admin-password.ts
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 10;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'hello@flipxer.com';
const adminNewPassword = process.env.ADMIN_NEW_PASSWORD;

async function main() {
    console.log('🔐 Admin Password Reset Script');
    console.log('================================\n');

    if (!process.env.DATABASE_URL) {
        console.error('❌ ERROR: DATABASE_URL environment variable is not set');
        console.log('\nUsage:');
        console.log('  DATABASE_URL="postgresql://..." npx ts-node scripts/reset-admin-password.ts');
        process.exit(1);
    }

    if (!adminNewPassword) {
        console.error('❌ ERROR: ADMIN_NEW_PASSWORD environment variable is not set');
        process.exit(1);
    }

    const prisma = new PrismaClient();

    try {
        // Check if admin exists
        console.log(`📧 Looking for admin user: ${ADMIN_EMAIL}`);
        const admin = await prisma.user.findUnique({
            where: { email: ADMIN_EMAIL },
            select: { id: true, email: true, firstName: true, lastName: true, userType: true }
        });

        if (!admin) {
            console.error(`❌ ERROR: Admin user with email "${ADMIN_EMAIL}" not found`);
            process.exit(1);
        }

        console.log(`✅ Found admin: ${admin.firstName} ${admin.lastName} (${admin.userType})`);

        // Hash the new password
        console.log('\n🔒 Hashing new password...');
        const hashedPassword = await bcrypt.hash(adminNewPassword, SALT_ROUNDS);

        // Update the password
        console.log('📝 Updating password in database...');
        await prisma.user.update({
            where: { email: ADMIN_EMAIL },
            data: { password: hashedPassword }
        });

        console.log('\n✅ SUCCESS! Admin password has been reset.');
        console.log('================================');
        console.log(`📧 Email: ${ADMIN_EMAIL}`);
        console.log('🔑 Password source: ADMIN_NEW_PASSWORD');
        console.log('================================\n');

    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

main();
