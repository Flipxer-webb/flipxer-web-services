const { Client } = require('pg');

const connStr = 'postgresql://resolve_db_user:Bje9vozyOzdFC7qxy4hybDDiSUle7Wyc@dpg-d5v3gcnpm1nc73c9q6fg-a.oregon-postgres.render.com/resolve_db_4a8l_b6ra_o5el_m1sw_p0r2_x75k_ayye';

async function main() {
  const c = new Client({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
  await c.connect();

  // 1. LEDGER ENTRIES (Trading Balance source)
  console.log('=== LEDGER ENTRIES SUMMARY ===');
  const ledgerCount = await c.query('SELECT COUNT(*) as cnt FROM "LedgerEntries"');
  console.log('Total ledger entries:', ledgerCount.rows[0].cnt);

  const ledgerByCurrency = await c.query('SELECT currency, COUNT(*) as cnt FROM "LedgerEntries" GROUP BY currency ORDER BY cnt DESC');
  console.log('By currency:');
  ledgerByCurrency.rows.forEach(r => console.log('  ', r.currency, ':', r.cnt));

  const ledgerByStatus = await c.query('SELECT status, COUNT(*) as cnt FROM "LedgerEntries" GROUP BY status ORDER BY cnt DESC');
  console.log('By status:');
  ledgerByStatus.rows.forEach(r => console.log('  ', r.status, ':', r.cnt));

  const ledgerByType = await c.query('SELECT type, COUNT(*) as cnt FROM "LedgerEntries" GROUP BY type ORDER BY cnt DESC');
  console.log('By type:');
  ledgerByType.rows.forEach(r => console.log('  ', r.type, ':', r.cnt));

  const distinctPairs = await c.query(`
    SELECT COUNT(*) as cnt FROM (
      SELECT DISTINCT "userId", currency FROM "LedgerEntries"
      WHERE "userId" > 0 AND status IN ('SETTLED', 'HOLD')
    ) sub
  `);
  console.log('Distinct user-currency pairs (SETTLED/HOLD, userId>0):', distinctPairs.rows[0].cnt);

  console.log('\nTop 15 trading balances:');
  const topBalances = await c.query(`
    SELECT DISTINCT ON (le."userId", le.currency)
      le."userId", le.currency, le."balanceAfter", le.status, le."sequenceNumber",
      u.email, u."firstName", u."lastName"
    FROM "LedgerEntries" le
    LEFT JOIN "Users" u ON le."userId" = u.id
    WHERE le."userId" > 0 AND le.status IN ('SETTLED', 'HOLD')
    ORDER BY le."userId", le.currency, le."sequenceNumber" DESC
  `);
  const sorted = topBalances.rows.sort((a,b) => parseFloat(b.balanceAfter) - parseFloat(a.balanceAfter));
  sorted.slice(0, 15).forEach(r => {
    console.log('  User ' + r.userId + ' (' + r.email + ') - ' + r.currency + ': ' + r.balanceAfter + ' [' + r.status + ']');
  });
  console.log('  ... total distinct pairs:', topBalances.rows.length);

  // 2. ORDERS (Swap Log source)
  console.log('\n=== ORDERS SUMMARY ===');
  const orderCount = await c.query('SELECT COUNT(*) as cnt FROM "Orders"');
  console.log('Total orders:', orderCount.rows[0].cnt);

  const orderByCat = await c.query('SELECT "orderCategory", COUNT(*) as cnt FROM "Orders" GROUP BY "orderCategory" ORDER BY cnt DESC');
  console.log('By category:');
  orderByCat.rows.forEach(r => console.log('  ', r.orderCategory, ':', r.cnt));

  const swapCount = await c.query("SELECT COUNT(*) as cnt FROM \"Orders\" WHERE \"orderCategory\"='SWAP'");
  console.log('Total SWAP orders:', swapCount.rows[0].cnt);

  const swapByStatus = await c.query("SELECT \"streamlinedStatus\", COUNT(*) as cnt FROM \"Orders\" WHERE \"orderCategory\"='SWAP' GROUP BY \"streamlinedStatus\" ORDER BY cnt DESC");
  console.log('SWAP orders by status:');
  swapByStatus.rows.forEach(r => console.log('  ', r.streamlinedStatus, ':', r.cnt));

  console.log('\nRecent 10 swap orders:');
  const recentSwaps = await c.query(`
    SELECT o.id, o."userId", o."fromCurrency", o."toCurrency", o."fromAmount", o."toAmount",
      o."streamlinedStatus", o."createdAt", u.email
    FROM "Orders" o
    LEFT JOIN "Users" u ON o."userId" = u.id
    WHERE o."orderCategory"='SWAP'
    ORDER BY o."createdAt" DESC
    LIMIT 10
  `);
  recentSwaps.rows.forEach(r => {
    console.log('  #' + r.id + ' User ' + r.userId + ' (' + r.email + '): ' + r.fromAmount + ' ' + r.fromCurrency + ' -> ' + r.toAmount + ' ' + r.toCurrency + ' [' + r.streamlinedStatus + '] at ' + r.createdAt);
  });

  // 3. WALLET/ON-CHAIN DATA
  console.log('\n=== WALLET/ON-CHAIN DATA ===');

  const awCount = await c.query('SELECT COUNT(*) as cnt FROM "AssetWallets"');
  console.log('AssetWallets count:', awCount.rows[0].cnt);
  const awCols = await c.query("SELECT column_name FROM information_schema.columns WHERE table_name='AssetWallets' ORDER BY ordinal_position");
  console.log('AssetWallets columns:', awCols.rows.map(r => r.column_name).join(', '));
  if (parseInt(awCount.rows[0].cnt) > 0) {
    const awSample = await c.query('SELECT * FROM "AssetWallets" LIMIT 5');
    awSample.rows.forEach(r => console.log('  ', JSON.stringify(r)));
  } else {
    console.log('  ** EMPTY TABLE **');
  }

  const cwaCount = await c.query('SELECT COUNT(*) as cnt FROM "CryptoWalletAddresses"');
  console.log('CryptoWalletAddresses count:', cwaCount.rows[0].cnt);
  const cwaCols = await c.query("SELECT column_name FROM information_schema.columns WHERE table_name='CryptoWalletAddresses' ORDER BY ordinal_position");
  console.log('CryptoWalletAddresses columns:', cwaCols.rows.map(r => r.column_name).join(', '));
  if (parseInt(cwaCount.rows[0].cnt) > 0) {
    const cwaSample = await c.query('SELECT * FROM "CryptoWalletAddresses" LIMIT 5');
    cwaSample.rows.forEach(r => console.log('  ', JSON.stringify(r)));
  } else {
    console.log('  ** EMPTY TABLE **');
  }

  const slCount = await c.query('SELECT COUNT(*) as cnt FROM "SolvencyLogs"');
  console.log('SolvencyLogs count:', slCount.rows[0].cnt);
  if (parseInt(slCount.rows[0].cnt) > 0) {
    const slCols = await c.query("SELECT column_name FROM information_schema.columns WHERE table_name='SolvencyLogs' ORDER BY ordinal_position");
    console.log('SolvencyLogs columns:', slCols.rows.map(r => r.column_name).join(', '));
    const slSample = await c.query('SELECT * FROM "SolvencyLogs" ORDER BY "createdAt" DESC LIMIT 5');
    slSample.rows.forEach(r => console.log('  ', JSON.stringify(r)));
  } else {
    console.log('  SolvencyLogs ** EMPTY TABLE **');
  }

  const fcCount = await c.query('SELECT COUNT(*) as cnt FROM "FloatConfigs"');
  console.log('FloatConfigs count:', fcCount.rows[0].cnt);
  if (parseInt(fcCount.rows[0].cnt) > 0) {
    const fcSample = await c.query('SELECT * FROM "FloatConfigs" LIMIT 5');
    fcSample.rows.forEach(r => console.log('  ', JSON.stringify(r)));
  }

  // 4. USERS
  console.log('\n=== USERS SUMMARY ===');
  const userCount = await c.query('SELECT COUNT(*) as cnt FROM "Users"');
  console.log('Total users:', userCount.rows[0].cnt);
  const userByType = await c.query('SELECT "userType", COUNT(*) as cnt FROM "Users" GROUP BY "userType" ORDER BY cnt DESC');
  console.log('By type:');
  userByType.rows.forEach(r => console.log('  ', r.userType, ':', r.cnt));

  // 5. HELD FUNDS
  console.log('\n=== HELD FUNDS ===');
  const holdEntries = await c.query(`
    SELECT "userId", currency, SUM("holdAmount"::numeric) as total_held, COUNT(*) as cnt
    FROM "LedgerEntries"
    WHERE status = 'HOLD' AND type = 'HOLD'
    GROUP BY "userId", currency
    HAVING SUM("holdAmount"::numeric) > 0
    ORDER BY total_held DESC
    LIMIT 10
  `);
  if (holdEntries.rows.length > 0) {
    console.log('Top held funds:');
    holdEntries.rows.forEach(r => console.log('  User ' + r.userId + ' - ' + r.currency + ': held=' + r.total_held + ' (' + r.cnt + ' entries)'));
  } else {
    console.log('No active holds found.');
  }

  await c.end();
  console.log('\n=== AUDIT COMPLETE ===');
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
