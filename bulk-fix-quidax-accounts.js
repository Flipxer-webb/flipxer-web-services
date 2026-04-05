// Bulk fix script to create Quidax sub-accounts for all affected users
// This runs against the PRODUCTION database via DATABASE_URL in .env

require('dotenv').config();
const { PrismaClient } = require("@prisma/client");
const axios = require("axios");

const QUIDAX_BASE_URL = process.env.QUIDAX_BASE_URL || "https://www.quidax.com/api/v1";
const QUIDAX_API_SECRET = process.env.QUIDAX_API_SECRET;

// Currencies to create wallets for
const SUPPORTED_CURRENCIES = ["btc", "eth", "usdt", "usdc", "sol", "xrp", "bnb", "trx"];

/**
 * Generate an aliased email for Gmail addresses to bypass Quidax duplicate check.
 */
function generateAliasedEmail(email) {
    const [localPart, domain] = email.split("@");
    const isGmail = domain.toLowerCase() === "gmail.com" || domain.toLowerCase() === "googlemail.com";
    const timestamp = Date.now().toString().slice(-6);
    
    if (isGmail) {
        return `${localPart}+flip${timestamp}@${domain}`;
    } else {
        return `${localPart}.flip${timestamp}@${domain}`;
    }
}

/**
 * Create Quidax sub-account for a user
 */
async function createQuidaxSubAccount(user) {
    const email = user.email;
    
    // First try with original email
    try {
        const response = await axios.post(
            `${QUIDAX_BASE_URL}/users`,
            {
                email: email,
                first_name: user.firstName || 'User',
                last_name: user.lastName || String(user.id)
            },
            {
                headers: {
                    'Authorization': `Bearer ${QUIDAX_API_SECRET}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        if (response.data.status === 'success') {
            return { success: true, subAccountId: response.data.data.id, usedEmail: email };
        }
    } catch (error) {
        const errorCode = error.response?.data?.data?.code;
        
        if (errorCode === 'E0101') {
            // Email already exists, try with aliased email
            console.log(`    E0101: Email exists, trying with alias...`);
            
            const aliasedEmail = generateAliasedEmail(email);
            
            try {
                const aliasResponse = await axios.post(
                    `${QUIDAX_BASE_URL}/users`,
                    {
                        email: aliasedEmail,
                        first_name: user.firstName || 'User',
                        last_name: user.lastName || String(user.id)
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${QUIDAX_API_SECRET}`,
                            'Content-Type': 'application/json'
                        }
                    }
                );
                
                if (aliasResponse.data.status === 'success') {
                    return { success: true, subAccountId: aliasResponse.data.data.id, usedEmail: aliasedEmail };
                }
            } catch (aliasError) {
                return { success: false, error: aliasError.response?.data?.message || aliasError.message };
            }
        }
        
        return { success: false, error: error.response?.data?.message || error.message };
    }
    
    return { success: false, error: 'Unknown error' };
}

/**
 * Create wallet records in database for a user
 */
async function createWalletRecords(prisma, userId, subAccountId) {
    let created = 0;
    
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
                
                await prisma.assetWallet.upsert({
                    where: {
                        userId_assetCurrency: {
                            userId: userId,
                            assetCurrency: currency
                        }
                    },
                    update: {
                        balance: wallet.balance || '0',
                        locked: wallet.locked || '0',
                    },
                    create: {
                        userId: userId,
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
                
                created++;
            }
        } catch (error) {
            // Skip wallet creation errors
        }
    }
    
    return created;
}

async function main() {
    console.log("\n========================================");
    console.log("  BULK FIX: Quidax Sub-Account Creation");
    console.log("========================================\n");
    
    if (!QUIDAX_API_SECRET) {
        console.error("ERROR: QUIDAX_API_SECRET not found in .env");
        process.exit(1);
    }

    const prisma = new PrismaClient();
    
    try {
        // Find all users without cryptoSubAccountId
        const affectedUsers = await prisma.user.findMany({
            where: {
                cryptoSubAccountId: null
            },
            select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
            },
            orderBy: { id: 'asc' }
        });
        
        console.log(`Found ${affectedUsers.length} users without Quidax sub-accounts:\n`);
        
        if (affectedUsers.length === 0) {
            console.log("All users already have sub-accounts. Nothing to do.");
            return;
        }
        
        // Display affected users
        affectedUsers.forEach(u => {
            console.log(`  [${u.id}] ${u.email} - ${u.firstName} ${u.lastName}`);
        });
        
        console.log("\n--- Starting bulk fix ---\n");
        
        let successCount = 0;
        let failCount = 0;
        const results = [];
        
        for (const user of affectedUsers) {
            console.log(`[${user.id}] Processing ${user.email}...`);
            
            // Create Quidax sub-account
            const result = await createQuidaxSubAccount(user);
            
            if (result.success) {
                // Update user with sub-account ID
                await prisma.user.update({
                    where: { id: user.id },
                    data: { cryptoSubAccountId: result.subAccountId }
                });
                
                // Create wallet records
                const walletsCreated = await createWalletRecords(prisma, user.id, result.subAccountId);
                
                console.log(`    ✓ Success! Sub-account: ${result.subAccountId} (${walletsCreated} wallets)`);
                if (result.usedEmail !== user.email) {
                    console.log(`    ℹ Used aliased email: ${result.usedEmail}`);
                }
                
                successCount++;
                results.push({ userId: user.id, email: user.email, status: 'success', subAccountId: result.subAccountId });
            } else {
                console.log(`    ✗ Failed: ${result.error}`);
                failCount++;
                results.push({ userId: user.id, email: user.email, status: 'failed', error: result.error });
            }
            
            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        // Summary
        console.log("\n========================================");
        console.log("  SUMMARY");
        console.log("========================================");
        console.log(`Total users processed: ${affectedUsers.length}`);
        console.log(`Successful: ${successCount}`);
        console.log(`Failed: ${failCount}`);
        
        if (failCount > 0) {
            console.log("\nFailed users:");
            results.filter(r => r.status === 'failed').forEach(r => {
                console.log(`  [${r.userId}] ${r.email}: ${r.error}`);
            });
        }
        
        console.log("\n✅ Bulk fix complete!");
        
    } catch (error) {
        console.error("Error:", error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
