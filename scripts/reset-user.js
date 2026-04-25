require('dotenv').config();
const { Client } = require('pg');

const connectionString = process.env.RESET_USER_DATABASE_URL || process.env.DATABASE_URL;
const targetUserEmail = process.env.TARGET_USER_EMAIL;
const useSsl = connectionString && !/localhost|127\.0\.0\.1/.test(connectionString);

const client = new Client({
    connectionString,
    ssl: useSsl ? { rejectUnauthorized: false } : false
});

async function main() {
    if (!connectionString) {
        console.error('Missing RESET_USER_DATABASE_URL or DATABASE_URL environment variable.');
        process.exit(1);
    }

    if (!targetUserEmail) {
        console.error('Missing TARGET_USER_EMAIL environment variable.');
        process.exit(1);
    }

    console.log('Connecting to database...');
    await client.connect();
    console.log('Connected!');

    // Find user
    const findResult = await client.query(
        'SELECT id, email, tier, "isBvnVerified", "isNinVerified", "isDocumentVerified", "isAddressVerified", "isIncomeVerified" FROM "User" WHERE email = $1',
        [targetUserEmail]
    );

    console.log('Current user state:', findResult.rows[0]);

    if (findResult.rows.length === 0) {
        console.log('User not found');
        await client.end();
        return;
    }

    // Reset user to tier 0
    const updateResult = await client.query(
        `UPDATE "User" SET 
      tier = 0,
      "isBvnVerified" = false,
      "isNinVerified" = false,
      "isDocumentVerified" = false,
      "isAddressVerified" = false,
      "isIncomeVerified" = false,
      bvn = NULL,
      nin = NULL
    WHERE email = $1
    RETURNING id, email, tier, "isBvnVerified", "isNinVerified", "isDocumentVerified", "isAddressVerified", "isIncomeVerified"`,
        [targetUserEmail]
    );

    console.log('\nUser reset successfully!');
    console.log('User after reset:', updateResult.rows[0]);

    await client.end();
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
