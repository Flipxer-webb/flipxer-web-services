require("dotenv").config();
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const sanitizeForLog = (value) => String(value).replaceAll(/[\r\n\t]/g, ' ');

// This uses the NestJS Quidax service indirectly via a raw API call
// to see exactly what timestamps Quidax returns

async function checkQuidaxTimestamps() {
    const axios = require("axios");
    
    // Get test user
    const user = await prisma.user.findFirst({
        where: { email: "testuser@flipxer.com" },
        select: { id: true, email: true, cryptoSubAccountId: true },
    });
    
    if (!user?.cryptoSubAccountId) {
        console.log("User not found or no crypto sub-account");
        return;
    }
    
    console.log(`User: ${user.email}`);
    console.log(`Sub-account ID: ${user.cryptoSubAccountId}\n`);

    const QUIDAX_BASE_URL = process.env.QUIDAX_BASE_URL;
    const QUIDAX_API_SECRET = process.env.QUIDAX_API_SECRET;
    
    console.log(`Base URL: ${QUIDAX_BASE_URL}`);
    console.log(`API Secret configured: ${QUIDAX_API_SECRET ? 'yes' : 'no'}\n`);

    try {
        const response = await axios.get(
            `${QUIDAX_BASE_URL}/users/${user.cryptoSubAccountId}/deposits`,
            {
                params: { currency: 'usdt' },
                headers: { 
                    Authorization: `Bearer ${QUIDAX_API_SECRET}`,
                    Accept: 'application/json',
                },
            }
        );

        console.log("Quidax Response Status:", response.status);
        console.log("Number of deposits:", response.data?.data?.length || 0);
        console.log("\nFull deposit data:");
        
        if (response.data?.data) {
            for (const deposit of response.data.data) {
                console.log("\n--- Deposit ---");
                console.log("ID:", deposit.id);
                console.log("Amount:", deposit.amount);
                console.log("Status:", deposit.status);
                console.log("State:", deposit.state);
                console.log("created_at:", sanitizeForLog(deposit.created_at));
                console.log("done_at:", sanitizeForLog(deposit.done_at));
                console.log("completed_at:", sanitizeForLog(deposit.completed_at));
                console.log("Full object keys:", sanitizeForLog(Object.keys(deposit).join(", ")));
            }
        }
    } catch (error) {
        console.error(
            "Error:",
            error.response?.status,
            sanitizeForLog(JSON.stringify(error.response?.data || error.message))
        );
    }
}

checkQuidaxTimestamps()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
