require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const p = new PrismaClient();

async function resetTestUserPassword() {
    const newPassword = 'Test@123';
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    
    const user = await p.user.update({
        where: { email: 'testuser@flipxer.com' },
        data: { password: hashedPassword },
        select: { id: true, email: true, firstName: true }
    });
    
    console.log('Updated user:', user);
    console.log('New password:', newPassword);
    await p.$disconnect();
}

resetTestUserPassword().catch(console.error);
