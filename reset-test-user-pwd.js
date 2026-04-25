require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('node:crypto');

const p = new PrismaClient();
const TEST_USER_EMAIL = process.env.TEST_USER_EMAIL || 'testuser@flipxer.com';

async function resetTestUserPassword() {
    const newPassword = process.env.RESET_TEST_USER_PASSWORD || `Test-${randomUUID()}`;
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    
    const user = await p.user.update({
        where: { email: TEST_USER_EMAIL },
        data: { password: hashedPassword },
        select: { id: true, email: true, firstName: true }
    });
    
    console.log('Updated user:', user);
    console.log('New password:', newPassword);
    await p.$disconnect();
}

resetTestUserPassword().catch(console.error);
