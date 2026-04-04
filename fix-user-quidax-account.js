// One-time script to:
// 1. Create Quidax sub-account with aliased email
// 2. Link sub-account to user
// 3. Revert email back to original
// 4. Trigger wallet creation

require('dotenv').config();
const { PrismaClient } = require("@prisma/client");
const axios = require("axios");

const QUIDAX_BASE_URL = process.env.QUIDAX_BASE_URL || "https://www.quidax.com/api/v1";
const QUIDAX_API_SECRET = process.env.QUIDAX_API_SECRET;

const USER_ID = 8;
const ORIGINAL_EMAIL = "magpiep18@gmail.com";
const ALIASED_EMAIL = "magpiep18+flip@gmail.com";

const SUPPORTED_CURRENCIES = ["btc", "eth", "usdt", "usdc", "sol", "xrp", "bnb", "trx", "matic", "avax"];

async function main() {
    if (!QUIDAX_API_SECRET) {
        console.error("ERROR: QUIDAX_API_SECRET not found in .env");
        process.exit(1);
    }

    const prisma = new PrismaClient();
    
    try {
        // Step 1: Get user info
        console.log("\n=== Step 1: Checking user ===");
        const user = await prisma.user.findUnique({
            where: { id: USER_ID },
            select: { id: true, email: true, firstName: true, lastName: true, cryptoSubAccountId: true }
        });
        
        if (!user) {
            console.error(`User ${USER_ID} not found!`);
            return;
        }
        
        console.log(`User: ${user.firstName} ${user.lastName}`);
        console.log(`Email: ${user.email}`);
        console.log(`Crypto Sub-Account: ${user.cryptoSubAccountId || '(none)'}`);
        
        if (user.cryptoSubAccountId) {
            console.log("\nUser already has a Quidax sub-account. No action needed.");
            return;
        }

        // Step 2: Create Quidax sub-account with aliased email
        console.log("\n=== Step 2: Creating Quidax sub-account ===");
        console.log(`Using aliased email: ${ALIASED_EMAIL}`);
        
        let subAccountId;
        try {
            const createResponse = await axios.post(
                `${QUIDAX_BASE_URL}/users`,
                {
                    email: ALIASED_EMAIL,
                    first_name: user.firstName,
                    last_name: user.lastName
                },
                {
                    headers: {
                        'Authorization': `Bearer ${QUIDAX_API_SECRET}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            if (createResponse.data.status === 'success') {
                subAccountId = createResponse.data.data.id;
                console.log(`✓ Sub-account created: ${subAccountId}`);
            } else {
                console.error("Failed to create sub-account:", createResponse.data);
                return;
            }
        } catch (error) {
            if (error.response?.data?.data?.code === 'E0101') {
                console.error("E0101 Error - email already exists in Quidax.");
                console.log("Trying with a different alias...");
                
                // Try with timestamp to make it unique
                const uniqueAlias = `magpiep18+flip${Date.now()}@gmail.com`;
                console.log(`Trying: ${uniqueAlias}`);
                
                const retryResponse = await axios.post(
                    `${QUIDAX_BASE_URL}/users`,
                    {
                        email: uniqueAlias,
                        first_name: user.firstName,
                        last_name: user.lastName
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${QUIDAX_API_SECRET}`,
                            'Content-Type': 'application/json'
                        }
                    }
                );
                
                if (retryResponse.data.status === 'success') {
                    subAccountId = retryResponse.data.data.id;
                    console.log(`✓ Sub-account created with unique alias: ${subAccountId}`);
                } else {
                    console.error("Failed to create sub-account:", retryResponse.data);
                    return;
                }
            } else {
                console.error("Error creating sub-account:", error.response?.data || error.message);
                return;
            }
        }

        // Step 3: Update user with sub-account ID and revert email
        console.log("\n=== Step 3: Linking sub-account and reverting email ===");
        
        await prisma.user.update({
            where: { id: USER_ID },
            data: {
                cryptoSubAccountId: subAccountId,
                email: ORIGINAL_EMAIL  // Revert to original email
            }
        });
        
        console.log(`✓ User updated:`);
        console.log(`  - cryptoSubAccountId: ${subAccountId}`);
        console.log(`  - email reverted to: ${ORIGINAL_EMAIL}`);

        // Step 4: Create wallet payment addresses for all currencies
        console.log("\n=== Step 4: Creating wallet payment addresses ===");
        
        for (const currency of SUPPORTED_CURRENCIES) {
            try {
                // First get or create the wallet
                const walletResponse = await axios.get(
                    `${QUIDAX_BASE_URL}/users/${subAccountId}/wallets/${currency}`,
                    {
                        headers: {
                            'Authorization': `Bearer ${QUIDAX_API_SECRET}`
                        }
                    }
                );
                
                if (walletResponse.data.status === 'success') {
                    const wallet = walletResponse.data.data;
                    console.log(`✓ ${currency.toUpperCase()} wallet: balance=${wallet.balance || '0'}`);
                    
                    // Create AssetWallet record in database
                    await prisma.assetWallet.upsert({
                        where: {
                            userId_currency: {
                                userId: USER_ID,
                                currency: currency
                            }
                        },
                        update: {
                            balance: parseFloat(wallet.balance || '0'),
                            lockedBalance: parseFloat(wallet.locked_balance || '0'),
                        },
                        create: {
                            userId: USER_ID,
                            currency: currency,
                            balance: parseFloat(wallet.balance || '0'),
                            lockedBalance: parseFloat(wallet.locked_balance || '0'),
                        }
                    });
                }
            } catch (error) {
                console.log(`✗ ${currency.toUpperCase()}: ${error.response?.data?.message || error.message}`);
            }
        }

        // Final verification
        console.log("\n=== Step 5: Verification ===");
        const updatedUser = await prisma.user.findUnique({
            where: { id: USER_ID },
            select: { 
                id: true, 
                email: true, 
                cryptoSubAccountId: true,
                assetWallets: {
                    select: { currency: true, balance: true }
                }
            }
        });
        
        console.log(`User ID: ${updatedUser.id}`);
        console.log(`Email: ${updatedUser.email}`);
        console.log(`Crypto Sub-Account: ${updatedUser.cryptoSubAccountId}`);
        console.log(`Asset Wallets: ${updatedUser.assetWallets.length}`);
        
        console.log("\n✅ SUCCESS! You can now log in with your original email.");
        console.log(`   Email: ${ORIGINAL_EMAIL}`);
        console.log(`   Password: TestUser@2024!`);
        
    } catch (error) {
        console.error("Error:", error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
