// Script to update user emails with Gmail + alias to bypass Quidax duplicate check
// This allows creating fresh sub-accounts while keeping email delivery working

const { PrismaClient } = require("@prisma/client");

async function updateUserEmailAlias() {
    const prisma = new PrismaClient();
    
    try {
        // User 8 - your account
        const userId = 8;
        const oldEmail = "magpiep18@gmail.com";
        const newEmail = "magpiep18+flip@gmail.com";
        
        // Check current state
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, email: true, cryptoSubAccountId: true }
        });
        
        if (!user) {
            console.log(`User ${userId} not found!`);
            return;
        }
        
        console.log("\n=== Current State ===");
        console.log(`User ID: ${user.id}`);
        console.log(`Current Email: ${user.email}`);
        console.log(`Crypto Sub-Account ID: ${user.cryptoSubAccountId || '(none)'}`);
        
        if (user.email !== oldEmail) {
            console.log(`\nEmail doesn't match expected ${oldEmail}, skipping.`);
            return;
        }
        
        // Update email
        const updated = await prisma.user.update({
            where: { id: userId },
            data: { email: newEmail },
            select: { id: true, email: true }
        });
        
        console.log("\n=== Updated ===");
        console.log(`User ID: ${updated.id}`);
        console.log(`New Email: ${updated.email}`);
        console.log("\nNow log in to the app again - the system will create a fresh Quidax sub-account!");
        console.log("(Emails will still be delivered to magpiep18@gmail.com)");
        
    } catch (error) {
        console.error("Error:", error);
    } finally {
        await prisma.$disconnect();
    }
}

updateUserEmailAlias();
