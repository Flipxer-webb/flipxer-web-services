require('dotenv').config();
const { Client } = require('pg');

const connStr = process.env.DATABASE_URL;

async function main() {
  const c = new Client({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
  await c.connect();

  // 1. Trading Balances - get the latest ledger entry per user+currency (highest sequenceNumber = most recent balance)
  // This mirrors the backend: distinct userId+currency ordered by sequenceNumber desc, using balanceAfter
  console.log('\n=== TRADING BALANCES (Latest per user+currency) ===');
  const r1 = await c.query(`
    SELECT DISTINCT ON (le."userId", le.currency)
           le.id, le."userId", u."firstName", u."lastName", u.email, le.currency,
           le."balanceAfter", le."updatedAt"
    FROM "LedgerEntries" le
    JOIN "Users" u ON u.id = le."userId"
    WHERE le."userId" > 0
      AND le.status IN ('SETTLED', 'HOLD')
    ORDER BY le."userId", le.currency, le."sequenceNumber" DESC
  `);
  // Also get hold amounts per user+currency
  const holdRes = await c.query(`
    SELECT "userId", currency, SUM("holdAmount") as total_held
    FROM "LedgerEntries"
    WHERE status = 'HOLD' AND type = 'HOLD'
    GROUP BY "userId", currency
  `);
  const holdMap = {};
  holdRes.rows.forEach(h => { holdMap[h.userId + '_' + h.currency] = parseFloat(h.total_held); });
  
  // Sort by updatedAt desc and take first 20
  const sorted = r1.rows.sort((a,b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, 20);
  sorted.forEach((r, i) => {
    const totalBalance = parseFloat(r.balanceAfter);
    const held = holdMap[r.userId + '_' + r.currency] || 0;
    const available = totalBalance - held;
    const status = held > 0 ? 'active' : totalBalance > 0 ? 'active' : 'inactive';
    console.log(`${i+1}. ${r.firstName} ${r.lastName} (${r.email}) | ${r.currency} | available=${available.toFixed(6)} | held=${held.toFixed(6)} | total=${totalBalance.toFixed(6)} | status=${status} | updated=${r.updatedAt}`);
  });
  console.log('Total distinct user+currency pairs:', r1.rows.length);

  // 2. Swap Log - orders with category SWAP
  console.log('\n=== SWAP LOG (Recent 20) ===');
  const r2 = await c.query(`
    SELECT o.id, o."userId", u."firstName", u."lastName", o."orderCategory",
           o."fromCurrency", o."toCurrency", o."fromAmount", o."toAmount",
           o."streamlinedStatus", o."createdAt"
    FROM "Orders" o
    JOIN "Users" u ON u.id = o."userId"
    WHERE o."orderCategory" = 'SWAP'
    ORDER BY o."createdAt" DESC
    LIMIT 20
  `);
  r2.rows.forEach((r, i) => {
    const rate = r.toAmount && r.fromAmount ? (parseFloat(r.toAmount) / parseFloat(r.fromAmount)).toFixed(6) : 'N/A';
    console.log(`${i+1}. id=${r.id} | ${r.firstName} ${r.lastName} | ${r.fromCurrency} -> ${r.toCurrency} | from=${parseFloat(r.fromAmount || 0).toFixed(6)} | to=${parseFloat(r.toAmount || 0).toFixed(6)} | rate=${rate} | status=${r.streamlinedStatus} | ${r.createdAt}`);
  });

  // 3. Total counts
  console.log('\n=== SUMMARY COUNTS ===');
  const r3 = await c.query(`SELECT COUNT(*) as total FROM "LedgerEntries"`);
  console.log('Total ledger entries:', r3.rows[0].total);

  const r4 = await c.query(`SELECT COUNT(*) as total FROM "Orders" WHERE "orderCategory" = 'SWAP'`);
  console.log('Total swap orders:', r4.rows[0].total);

  const r5 = await c.query(`
    SELECT COUNT(*) as total FROM (
      SELECT DISTINCT "userId", currency FROM "LedgerEntries"
    ) sub
  `);
  console.log('Distinct user+currency pairs (trading balances):', r5.rows[0].total);

  // 4. Wallet data (AssetWallets)
  console.log('\n=== ASSET WALLETS (Recent 10) ===');
  const r6 = await c.query(`
    SELECT aw.id, aw."userId", u."firstName", u."lastName", aw.currency, aw.address, aw.network, aw."createdAt"
    FROM "AssetWallets" aw
    JOIN "Users" u ON u.id = aw."userId"
    ORDER BY aw."createdAt" DESC
    LIMIT 10
  `);
  r6.rows.forEach((r, i) => {
    console.log(`${i+1}. id=${r.id} | ${r.firstName} ${r.lastName} | ${r.currency} | network=${r.network} | addr=${r.address ? r.address.substring(0,20) + '...' : 'none'} | ${r.createdAt}`);
  });

  const r7 = await c.query(`SELECT COUNT(*) as total FROM "AssetWallets"`);
  console.log('Total asset wallets:', r7.rows[0].total);

  await c.end();
}

main().catch(e => { console.error(e); process.exit(1); });
