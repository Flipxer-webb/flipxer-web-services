const { Client } = require('pg');

const client = new Client({
    host: 'dpg-d44d3om3jp1c739lgge0-a.oregon-postgres.render.com',
    port: 5432,
    user: 'resolve_db_user',
    password: 'Bje9vozyOzdFC7qxy4hybDDiSUle7Wyc',
    database: 'resolve_db',
    ssl: true
});

async function main() {
    console.log('Connecting to database...');
    await client.connect();
    console.log('Connected!');

    // Find user
    const findResult = await client.query(
        'SELECT id, email, tier, "isBvnVerified", "isNinVerified", "isDocumentVerified", "isAddressVerified", "isIncomeVerified" FROM "User" WHERE email = $1',
        ['magpiep18@gmail.com']
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
        ['magpiep18@gmail.com']
    );

    console.log('\nUser reset successfully!');
    console.log('User after reset:', updateResult.rows[0]);

    await client.end();
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
