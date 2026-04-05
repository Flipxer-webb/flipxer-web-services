require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const NEW_PASSWORD = 'FlipxerAdmin2025!';

async function main() {
    const prisma = new PrismaClient();

    try {
        console.log('🔐 Resetting Super Admin Password...\n');

        // Hash the new password
        const hashedPassword = await bcrypt.hash(NEW_PASSWORD, 10);

        // Update the admin password
        const admin = await prisma.user.update({
            where: { email: 'hello@flipxer.com' },
            data: { password: hashedPassword },
            select: { id: true, email: true, firstName: true, lastName: true }
        });

        console.log('✅ SUCCESS! Password reset complete.');
        console.log('================================');
        console.log('📧 Email:', admin.email);
        console.log('👤 Name:', admin.firstName, admin.lastName);
        console.log('🔑 New Password:', NEW_PASSWORD);
        console.log('================================\n');

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await prisma.$disconnect();
    }
}

main();
