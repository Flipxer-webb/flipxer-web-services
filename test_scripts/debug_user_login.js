const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();
const email = process.env.TEST_EMAIL || 'magpiep18@gmail.com';
const password = process.env.TEST_PASSWORD;
if (!password) { console.error('ERROR: TEST_PASSWORD env var required'); process.exit(1); }

async function main() {
    console.log(`Checking user: ${email}`);
    const user = await prisma.user.findUnique({
        where: { email },
        // include: { flaggedRecord: true } // Optional: include if we really need it, but let's keep it simple
    });

    if (!user) {
        console.log('User NOT FOUND in database.');

        // Check if database is empty or has other users
        const count = await prisma.user.count();
        console.log(`Total users in database: ${count}`);

        if (count > 0) {
            const users = await prisma.user.findMany({ take: 5, select: { id: true, email: true } });
            console.log('First 5 users found:');
            users.forEach(u => console.log(`- ID: ${u.id}, Email: ${u.email}`));
        }
        return;
    }

    console.log('User found in database.');
    console.log(`ID: ${user.id}`);
    console.log(`Status: ${user.status}`);
    console.log(`Email Verified: ${user.isEmailVerified}`);
    console.log(`Password Hash exist: ${!!user.password}`);
    console.log(`Deleted: ${user.isDeleted}`);

    if (user.password) {
        const isMatch = await bcrypt.compare(password, user.password);
        console.log(`Password match result: ${isMatch}`);

        // Debug: Generate a new hash to see format (optional)
        // const newHash = await bcrypt.hash(password, 10);
        // console.log('New hash sample:', newHash);
    } else {
        console.log('User has NO password set.');
    }
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
