require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const axios = require("axios");

const prisma = new PrismaClient();

async function fixDepositTimestamps() {
    console.log("Fixing deposit timestamps...\n");

    // Get all RECEIVE orders that might have wrong timestamps
    const deposits = await prisma.order.findMany({
        where: {
            orderCategory: "RECEIVE",
            providerOrderId: { not: null },
        },
        include: {
            user: {
                select: {
                    id: true,
                    email: true,
                    cryptoSubAccountId: true,
                },
            },
        },
    });

    console.log(`Found ${deposits.length} deposit orders to check\n`);

    // Group by user to minimize API calls
    const userDeposits = {};
    for (const deposit of deposits) {
        if (!deposit.user?.cryptoSubAccountId) continue;
        if (!userDeposits[deposit.user.cryptoSubAccountId]) {
            userDeposits[deposit.user.cryptoSubAccountId] = {
                user: deposit.user,
                deposits: [],
            };
        }
        userDeposits[deposit.user.cryptoSubAccountId].deposits.push(deposit);
    }

    const QUIDAX_API_KEY = process.env.QUIDAX_API_SECRET;
    if (!QUIDAX_API_KEY) {
        console.error("QUIDAX_API_SECRET not set!");
        process.exit(1);
    }

    for (const [subAccountId, data] of Object.entries(userDeposits)) {
        console.log(`\nProcessing user: ${data.user.email} (${subAccountId})`);
        
        // Get unique currencies
        const currencies = [...new Set(data.deposits.map(d => d.currency.toLowerCase()))];
        
        for (const currency of currencies) {
            try {
                console.log(`  Fetching ${currency} deposits from Quidax...`);
                
                const baseUrl = process.env.QUIDAX_BASE_URL || 'https://www.quidax.com/api/v1';
                const response = await axios.get(
                    `${baseUrl}/users/${subAccountId}/deposits`,
                    {
                        params: { currency },
                        headers: { Authorization: `Bearer ${QUIDAX_API_KEY}` },
                    }
                );

                const quidaxDeposits = response.data?.data || [];
                console.log(`  Found ${quidaxDeposits.length} ${currency} deposits on Quidax`);

                // Match and update timestamps
                for (const deposit of data.deposits.filter(d => d.currency.toLowerCase() === currency)) {
                    const quidaxDeposit = quidaxDeposits.find(qd => qd.id === deposit.providerOrderId);
                    
                    if (quidaxDeposit) {
                        const correctCreatedAt = new Date(quidaxDeposit.created_at);
                        const correctUpdatedAt = quidaxDeposit.done_at 
                            ? new Date(quidaxDeposit.done_at) 
                            : quidaxDeposit.completed_at 
                                ? new Date(quidaxDeposit.completed_at)
                                : correctCreatedAt;

                        // Check if timestamps differ significantly (more than 1 hour)
                        const timeDiff = Math.abs(deposit.createdAt.getTime() - correctCreatedAt.getTime());
                        
                        if (timeDiff > 60 * 60 * 1000) { // More than 1 hour difference
                            console.log(`  Updating deposit ${deposit.id}:`);
                            console.log(`    Old createdAt: ${deposit.createdAt.toISOString()}`);
                            console.log(`    New createdAt: ${correctCreatedAt.toISOString()}`);
                            
                            await prisma.order.update({
                                where: { id: deposit.id },
                                data: {
                                    createdAt: correctCreatedAt,
                                    updatedAt: correctUpdatedAt,
                                },
                            });
                            
                            console.log(`    ✓ Updated!`);
                        } else {
                            console.log(`  Deposit ${deposit.id} timestamp is correct (within 1 hour)`);
                        }
                    } else {
                        console.log(`  ⚠ Could not find Quidax deposit for order ${deposit.id} (providerOrderId: ${deposit.providerOrderId})`);
                    }
                }

                // Small delay between currency fetches
                await new Promise(resolve => setTimeout(resolve, 200));
                
            } catch (error) {
                console.error(`  Error fetching ${currency} deposits: ${error.message}`);
            }
        }
    }

    console.log("\n✓ Timestamp fix complete!");
}

fixDepositTimestamps()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
