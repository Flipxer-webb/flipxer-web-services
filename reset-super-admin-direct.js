require('dotenv').config();
const { Client } = require('pg');
const bcrypt = require('bcryptjs');

const NEW_PASSWORD = process.env.NEW_ADMIN_PASSWORD || 'FlipxerAdmin2025!';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'hello@flipxer.com';

// Try internal Render connection (without -a suffix)
const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 30000,
    query_timeout: 30000,
});

async function main() {
    try {
        console.log('🔐 Super Admin Password Reset Script');
        console.log('=====================================\n');

        console.log('📡 Connecting to database...');
        console.log('(This may take a moment for external connections)\n');

        await client.connect();
        console.log('✅ Connected!\n');

        // First, find the admin user
        console.log(`📧 Looking for admin: ${ADMIN_EMAIL}`);
        const findResult = await client.query(
            `SELECT id, email, "firstName", "lastName", "userType" FROM "User" WHERE email = $1`,
            [ADMIN_EMAIL]
        );

        if (findResult.rows.length === 0) {
            console.log('❌ Admin user not found!');
            return;
        }

        const admin = findResult.rows[0];
        console.log(`✅ Found: ${admin.firstName} ${admin.lastName} (${admin.userType})\n`);

        // Hash the new password
        console.log('🔒 Hashing new password...');
        const hashedPassword = await bcrypt.hash(NEW_PASSWORD, 10);

        // Update the password
        console.log('📝 Updating password in database...');
        const updateResult = await client.query(
            `UPDATE "User" SET password = $1 WHERE email = $2`,
            [hashedPassword, ADMIN_EMAIL]
        );

        console.log(`✅ Updated ${updateResult.rowCount} row(s)\n`);

        console.log('=====================================');
        console.log('✅ SUCCESS! Password has been reset.');
        console.log('=====================================');
        console.log(`📧 Email: ${ADMIN_EMAIL}`);
        console.log(`🔑 Password: ${NEW_PASSWORD}`);
        console.log('=====================================\n');

    } catch (err) {
        console.error('❌ Error:', err.message);
        console.log('\n⚠️  If connection fails, your database may only allow');
        console.log('   connections from Render services. You can:');
        console.log('   1. Run this script in Render Shell');
        console.log('   2. Use Render\'s database dashboard');
        console.log('   3. Enable external connections in Render settings\n');
    } finally {
        await client.end();
    }
}

main();
