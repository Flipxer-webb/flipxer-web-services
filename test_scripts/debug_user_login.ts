import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const email = 'magpiep18@gmail.com';
const password = 'TestUser@2024!';

async function main() {
    console.log(`Checking user: ${email}`);
    const user = await prisma.user.findUnique({
        where: { email },
    });

    if (!user) {
        console.log('User NOT FOUND in database.');
        return;
    }

    console.log('User found in database.');
    console.log(`ID: ${user.id}`);
    console.log(`Status: ${user.status}`);
    console.log(`Email Verified: ${user.isEmailVerified}`);
    console.log(`Password Hash exist: ${!!user.password}`);
    console.log(`Deleted: ${user.isDeleted}`);
    console.log(`Flagged: ${JSON.stringify(user.flaggedRecord || {})}`);

    if (user.password) {
        const isMatch = await bcrypt.compare(password, user.password);
        console.log(`Password match result: ${isMatch}`);
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
