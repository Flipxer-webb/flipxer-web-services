const { Client } = require('pg');
const c = new Client({
    connectionString: 'postgresql://resolve_db_user:Bje9vozyOzdFC7qxy4hybDDiSUle7Wyc@dpg-d5v3gcnpm1nc73c9q6fg-a.oregon-postgres.render.com/resolve_db_4a8l_b6ra_o5el_m1sw_p0r2_x75k_ayye',
    ssl: { rejectUnauthorized: false }
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
