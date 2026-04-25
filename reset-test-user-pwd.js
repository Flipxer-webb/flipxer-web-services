require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('node:crypto');

const p = new PrismaClient();
const TEST_USER_EMAIL = process.env.TEST_USER_EMAIL || 'testuser@flipxer.com';
const resetPassword = process.env.RESET_TEST_USER_PASSWORD;

async function resetTestUserPassword() {
    if (!resetPassword) {
        throw new Error('RESET_TEST_USER_PASSWORD environment variable is required.');
    }

    const hashedPassword = await bcrypt.hash(resetPassword, 10);
    
    const user = await p.user.update({
        where: { email: TEST_USER_EMAIL },
        data: { password: hashedPassword },
        select: { id: true, email: true, firstName: true }
    });
    
    console.log('Updated user:', user);
    console.log('Password source: RESET_TEST_USER_PASSWORD');
    await p.$disconnect();
}

resetTestUserPassword().catch(console.error);
