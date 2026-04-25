require('dotenv').config();
const { Client } = require('pg');
const connectionString = process.env.DATABASE_URL;
const useSsl = connectionString && !/localhost|127\.0\.0\.1/.test(connectionString);

if (!connectionString) {
    console.error('Missing DATABASE_URL environment variable.');
    process.exit(1);
}

const c = new Client({
    connectionString,
    ssl: useSsl ? { rejectUnauthorized: false } : false
});

async function main() {
    await c.connect();
    
    // Check the specific entry
    const r1 = await c.query(
        `SELECT id, "userId", currency, credit, status, "sweepStatus", type, "createdAt" 
         FROM "LedgerEntries" WHERE id = $1`,
        ['1e41bd7d-54af-4b37-837b-e34fa15ad169']
    );
    console.log('Entry:', JSON.stringify(r1.rows, null, 2));
    
    // Also check all current PENDING sweeps
    const r2 = await c.query(
        `SELECT id, "userId", currency, credit, status, "sweepStatus", type, "createdAt" 
         FROM "LedgerEntries" 
         WHERE type = 'DEPOSIT' AND "sweepStatus" = 'PENDING'`
    );
    console.log('\nAll PENDING deposits:', JSON.stringify(r2.rows, null, 2));
    
    // Summary counts
    const r3 = await c.query(
        `SELECT "sweepStatus", COUNT(*) as count 
         FROM "LedgerEntries" 
         WHERE type = 'DEPOSIT' 
         GROUP BY "sweepStatus" ORDER BY count DESC`
    );
    console.log('\nSweep status summary:', JSON.stringify(r3.rows, null, 2));
    
    await c.end();
}

main().catch(e => { console.error(e); c.end(); });
