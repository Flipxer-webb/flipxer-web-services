// Script to find all users without crypto sub-accounts
// These are likely registered under the old Quidax master account

const { PrismaClient } = require("@prisma/client");

async function findAffectedUsers() {
    const prisma = new PrismaClient();
    
    try {
        // Find all users without cryptoSubAccountId
        const usersWithoutSubAccount = await prisma.user.findMany({
            where: {
                cryptoSubAccountId: null
            },
            select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                createdAt: true,
            },
            orderBy: {
                createdAt: 'asc'
            }
        });

        console.log("\n=== Users WITHOUT Quidax Sub-Account ===\n");
        console.log(`Total: ${usersWithoutSubAccount.length} users\n`);
        
        if (usersWithoutSubAccount.length === 0) {
            console.log("All users have Quidax sub-accounts!");
            return;
        }

        // Display in a table format
        console.log("ID\tEmail\t\t\t\t\tName\t\t\tCreated");
        console.log("-".repeat(100));
        
        usersWithoutSubAccount.forEach(user => {
            const email = user.email.padEnd(35);
            const name = `${user.firstName || ''} ${user.lastName || ''}`.padEnd(20);
            const created = user.createdAt.toISOString().split('T')[0];
            console.log(`${user.id}\t${email}\t${name}\t${created}`);
        });

        // Generate email list for Quidax support
        console.log("\n\n=== Email List for Quidax Support ===\n");
        console.log("Copy and send this list to Quidax asking for sub-account IDs:\n");
        console.log("---");
        usersWithoutSubAccount.forEach(user => {
            console.log(user.email);
        });
        console.log("---");

        console.log("\n\n=== Suggested Email Template for Quidax ===\n");
        console.log(`
Subject: Request for Sub-Account IDs - Migration from Previous Master Account

Hi Quidax Support,

We recently migrated our platform and are now using a new Quidax master account.
However, some of our users were previously registered under our old master account.

When we try to create sub-accounts for these users, we get error E0101 
("Failed to create User") because their emails are already registered globally.

Could you please provide us with the sub-account IDs for the following ${usersWithoutSubAccount.length} email(s)?
We need these IDs to link the existing sub-accounts to our users.

Emails:
${usersWithoutSubAccount.map(u => `- ${u.email}`).join('\n')}

Alternatively, if possible, could you transfer these sub-accounts to our 
current master account, or delete them so we can recreate them?

Thank you for your assistance.
        `.trim());

    } catch (error) {
        console.error("Error:", error);
    } finally {
        await prisma.$disconnect();
    }
}

findAffectedUsers();
