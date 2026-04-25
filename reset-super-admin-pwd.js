require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'hello@flipxer.com';
const adminNewPassword = process.env.ADMIN_NEW_PASSWORD;

async function main() {
    const prisma = new PrismaClient();

    try {
        console.log('🔐 Resetting Super Admin Password...\n');

        if (!adminNewPassword) {
            console.error('❌ ADMIN_NEW_PASSWORD environment variable is required.');
            process.exit(1);
        }

        // Hash the new password
        const hashedPassword = await bcrypt.hash(adminNewPassword, 10);

        // Update the admin password
        const admin = await prisma.user.update({
            where: { email: ADMIN_EMAIL },
            data: { password: hashedPassword },
            select: { id: true, email: true, firstName: true, lastName: true }
        });

        console.log('✅ SUCCESS! Password reset complete.');
        console.log('================================');
        console.log('📧 Email:', admin.email);
        console.log('👤 Name:', admin.firstName, admin.lastName);
        console.log('🔑 Password source: ADMIN_NEW_PASSWORD');
        console.log('================================\n');

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await prisma.$disconnect();
    }
}

main();
