
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function disable2FA() {
    const email = 'business_test_check_limits_prod_verify@yjo4y7so.mailosaur.net';
    try {
        await prisma.user.update({
            where: { email },
            data: { isTwoFactorEnabled: false }
        });
        console.log('2FA disabled for user');
    } catch (error) {
        console.error('Error:', error);
    } finally {
        await prisma.$disconnect();
    }
}

disable2FA();
