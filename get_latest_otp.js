
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function getCode() {
    const email = process.argv[2];
    if (!email) {
        console.log("Usage: node get_latest_otp.js <email>");
        process.exit(1);
    }
    try {
        const request = await prisma.accountVerificationRequest.findFirst({
            where: { email },
            orderBy: { createdAt: 'desc' }
        });
        console.log("OTP_RESULT:" + (request ? request.code : "NULL"));
    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}
getCode();
