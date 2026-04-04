// Script to finalize setup:
// 1. Revert email back to original
// 2. Ensure all wallets are created

require('dotenv').config();
const { PrismaClient } = require("@prisma/client");
const axios = require("axios");

const QUIDAX_BASE_URL = process.env.QUIDAX_BASE_URL || "https://www.quidax.com/api/v1";
const QUIDAX_API_SECRET = process.env.QUIDAX_API_SECRET;

const USER_ID = 8;
const ORIGINAL_EMAIL = "magpiep18@gmail.com";

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
            select: { 
                id: true, 
                email: true, 
                firstName: true, 
                lastName: true, 
                cryptoSubAccountId: true,
                assetWallets: { select: { assetCurrency: true, balance: true } }
            }
        });
        
        if (!user) {
            console.error(`User ${USER_ID} not found!`);
            return;
        }
        
        console.log(`User: ${user.firstName} ${user.lastName}`);
        console.log(`Email: ${user.email}`);
        console.log(`Crypto Sub-Account: ${user.cryptoSubAccountId || '(none)'}`);
        console.log(`Existing Wallets: ${user.assetWallets.length}`);
        
        if (!user.cryptoSubAccountId) {
            console.error("User doesn't have a Quidax sub-account yet!");
            return;
        }

        // Step 2: Revert email if needed
        if (user.email !== ORIGINAL_EMAIL) {
            console.log("\n=== Step 2: Reverting email ===");
            await prisma.user.update({
                where: { id: USER_ID },
                data: { email: ORIGINAL_EMAIL }
            });
            console.log(`✓ Email reverted from ${user.email} to ${ORIGINAL_EMAIL}`);
        } else {
            console.log("\n=== Step 2: Email already correct ===");
        }

        // Step 3: Create wallets if needed
        console.log("\n=== Step 3: Ensuring wallets exist ===");
        
        const subAccountId = user.cryptoSubAccountId;
        let walletsCreated = 0;
        
        for (const currency of SUPPORTED_CURRENCIES) {
            try {
                // Get wallet from Quidax
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
                    
                    // Upsert AssetWallet record in database
                    await prisma.assetWallet.upsert({
                        where: {
                            userId_assetCurrency: {
                                userId: USER_ID,
                                assetCurrency: currency
                            }
                        },
                        update: {
                            balance: wallet.balance || '0',
                            locked: wallet.locked || '0',
                        },
                        create: {
                            userId: USER_ID,
                            quidaxWalletId: wallet.id || `${subAccountId}-${currency}`,
                            assetName: wallet.name || currency.toUpperCase(),
                            assetCurrency: currency,
                            balance: wallet.balance || '0',
                            locked: wallet.locked || '0',
                            staked: '0',
                            convertedBalance: '0',
                            referenceCurrency: 'ngn',
                            isCrypto: true,
                            defaultNetwork: wallet.default_network || currency,
                            blockchainEnabled: true,
                            networks: wallet.networks || []
                        }
                    });
                    
                    console.log(`✓ ${currency.toUpperCase()}: balance=${wallet.balance || '0'}`);
                    walletsCreated++;
                }
            } catch (error) {
                console.log(`✗ ${currency.toUpperCase()}: ${error.response?.data?.message || error.message}`);
            }
        }

        // Final verification
        console.log("\n=== Final Verification ===");
        const updatedUser = await prisma.user.findUnique({
            where: { id: USER_ID },
            select: { 
                id: true, 
                email: true, 
                cryptoSubAccountId: true,
                assetWallets: {
                    select: { assetCurrency: true, balance: true }
                }
            }
        });
        
        console.log(`User ID: ${updatedUser.id}`);
        console.log(`Email: ${updatedUser.email}`);
        console.log(`Crypto Sub-Account: ${updatedUser.cryptoSubAccountId}`);
        console.log(`Asset Wallets: ${updatedUser.assetWallets.length}`);
        
        if (updatedUser.assetWallets.length > 0) {
            console.log("\nWallet Details:");
            updatedUser.assetWallets.forEach(w => {
                console.log(`  ${w.assetCurrency.toUpperCase()}: ${w.balance}`);
            });
        }
        
        console.log("\n✅ SUCCESS! You can now log in normally.");
        console.log(`   Email: ${updatedUser.email}`);
        console.log(`   Password: TestUser@2024!`);
        
    } catch (error) {
        console.error("Error:", error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
