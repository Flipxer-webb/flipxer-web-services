const speakeasy = require('speakeasy');
const { PrismaClient } = require('@prisma/client');

async function get2FA() {
  const p = new PrismaClient();
  try {
    const user = await p.user.findFirst({ 
      where: { email: 'magpiep18@gmail.com' },
      select: { id: true, email: true, twoFactorSecret: true }
    });
    
    if (user && user.twoFactorSecret) {
      const token = speakeasy.totp({
        secret: user.twoFactorSecret,
        encoding: 'base32'
      });
      console.log(token);
    } else {
      console.log('No 2FA secret found');
    }
  } finally {
    await p.$disconnect();
  }
}

get2FA();
