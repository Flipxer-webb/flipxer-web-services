require('dotenv').config();
const { Client } = require('pg');

const connStr = process.env.DATABASE_URL;

async function main() {
  const c = new Client({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
  await c.connect();

  // 1. List all tables
  const tables = await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  console.log('=== ALL TABLES ===');
  tables.rows.forEach(r => console.log(' ', r.tablename));

  // 2. Check LedgerEntry table - trading balances
  console.log('\n=== LEDGER ENTRY SUMMARY ===');
  const ledgerCount = await c.query('SELECT COUNT(*) as cnt FROM "LedgerEntry"');
  console.log('Total ledger entries:', ledgerCount.rows[0].cnt);

  const ledgerByCurrency = await c.query('SELECT currency, COUNT(*) as cnt, SUM("balanceAfter"::numeric) as total_bal FROM "LedgerEntry" GROUP BY currency ORDER BY currency');
  console.log('By currency:');
  ledgerByCurrency.rows.forEach(r => console.log('  ', r.currency, '- count:', r.cnt, '- sum balanceAfter:', r.total_bal));

  const ledgerByStatus = await c.query('SELECT status, COUNT(*) as cnt FROM "LedgerEntry" GROUP BY status ORDER BY status');
  console.log('By status:');
  ledgerByStatus.rows.forEach(r => console.log('  ', r.status, ':', r.cnt));

  const ledgerByType = await c.query('SELECT type, COUNT(*) as cnt FROM "LedgerEntry" GROUP BY type ORDER BY cnt DESC');
  console.log('By type:');
  ledgerByType.rows.forEach(r => console.log('  ', r.type, ':', r.cnt));

  // 3. Check Orders table - swap log
  console.log('\n=== ORDERS SUMMARY ===');
  const orderCount = await c.query('SELECT COUNT(*) as cnt FROM "Order"');
  console.log('Total orders:', orderCount.rows[0].cnt);

  const swapCount = await c.query("SELECT COUNT(*) as cnt FROM \"Order\" WHERE \"orderCategory\"='SWAP'");
  console.log('Swap orders:', swapCount.rows[0].cnt);

  const orderByCat = await c.query('SELECT "orderCategory", COUNT(*) as cnt FROM "Order" GROUP BY "orderCategory" ORDER BY cnt DESC');
  console.log('By category:');
  orderByCat.rows.forEach(r => console.log('  ', r.orderCategory, ':', r.cnt));

  const orderByStatus = await c.query('SELECT "streamlinedStatus", COUNT(*) as cnt FROM "Order" GROUP BY "streamlinedStatus" ORDER BY cnt DESC');
  console.log('By streamlinedStatus:');
  orderByStatus.rows.forEach(r => console.log('  ', r.streamlinedStatus, ':', r.cnt));

  // 4. Check if there's a wallets or on-chain related table
  console.log('\n=== WALLET-RELATED TABLES ===');
  const walletTables = await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND LOWER(tablename) LIKE '%wallet%'");
  walletTables.rows.forEach(r => console.log('  ', r.tablename));

  // 5. Check users count for context
  console.log('\n=== USERS SUMMARY ===');
  const userCount = await c.query('SELECT COUNT(*) as cnt FROM "User"');
  console.log('Total users:', userCount.rows[0].cnt);

  const userByType = await c.query('SELECT "userType", COUNT(*) as cnt FROM "User" GROUP BY "userType" ORDER BY cnt DESC');
  console.log('By type:');
  userByType.rows.forEach(r => console.log('  ', r.userType, ':', r.cnt));

  // 6. Trading balance: distinct user-currency pairs with latest balanceAfter
  console.log('\n=== TRADING BALANCES (top 10 by balance) ===');
  const tradingBal = await c.query(`
    SELECT DISTINCT ON ("userId", currency) 
      "userId", currency, "balanceAfter", status, "sequenceNumber"
    FROM "LedgerEntry"
    WHERE "userId" > 0 AND status IN ('SETTLED', 'HOLD')
    ORDER BY "userId", currency, "sequenceNumber" DESC
    LIMIT 10
  `);
  tradingBal.rows.forEach(r => console.log('  User', r.userId, r.currency, '- balance:', r.balanceAfter, '- status:', r.status));

  // 7. Top swap orders
  console.log('\n=== RECENT SWAP ORDERS (top 10) ===');
  const recentSwaps = await c.query(`
    SELECT o.id, o."userId", o."fromCurrency", o."toCurrency", o."fromAmount", o."toAmount",
      o."streamlinedStatus", o."createdAt"
    FROM "Order" o
    WHERE o."orderCategory"='SWAP'
    ORDER BY o."createdAt" DESC
    LIMIT 10
  `);
  recentSwaps.rows.forEach(r => console.log('  Order', r.id, '- User', r.userId, r.fromCurrency, '->', r.toCurrency, 'amt:', r.fromAmount, '->', r.toAmount, 'status:', r.streamlinedStatus, 'at:', r.createdAt));

  // 8. Check columns of LedgerEntry for wallet address info
  console.log('\n=== LEDGER ENTRY COLUMNS ===');
  const ledgerCols = await c.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name='LedgerEntry' ORDER BY ordinal_position");
  ledgerCols.rows.forEach(r => console.log('  ', r.column_name, '-', r.data_type));

  // 9. Look for any Wallet model
  console.log('\n=== CHECKING FOR WALLET/ONCHAIN MODELS ===');
  const allTables = tables.rows.map(r => r.tablename);
  const relevantTables = allTables.filter(t => /wallet|chain|solvency|balance|address/i.test(t));
  console.log('Relevant tables found:', relevantTables.length > 0 ? relevantTables.join(', ') : 'NONE');

  // 10. Check if CryptoWallet or similar exists
  for (const tbl of allTables) {
    if (/wallet|crypto|address/i.test(tbl)) {
      const cnt = await c.query(`SELECT COUNT(*) as cnt FROM "${tbl}"`);
      console.log(`  ${tbl}: ${cnt.rows[0].cnt} rows`);
      const sample = await c.query(`SELECT * FROM "${tbl}" LIMIT 3`);
      if (sample.rows.length > 0) {
        console.log('  Sample columns:', Object.keys(sample.rows[0]).join(', '));
        sample.rows.forEach(r => console.log('   ', JSON.stringify(r)));
      }
    }
  }

  await c.end();
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
