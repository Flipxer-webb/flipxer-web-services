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

c.connect().then(async () => {
  // All orders for user 7 that show as "pending" in any way
  const r = await c.query(`
    SELECT id, status, "streamlinedStatus", fulfilled, "paymentStatus",
           "orderCategory", amount, currency, "createdAt", "transactionId"
    FROM "Orders"
    WHERE "userId" = 7
      AND ("streamlinedStatus" = 'pending' OR status IN ('pending','initiated','processing','confirmed'))
    ORDER BY "createdAt" DESC
  `);

  console.log('=== Orders showing as pending for user #7 ===');
  console.table(r.rows.map(r => ({
    order: r.id,
    txId: r.transactionId,
    status: r.status,
    streamlined: r.streamlinedStatus,
    fulfilled: r.fulfilled,
    payStatus: r.paymentStatus,
    category: r.orderCategory,
    amount: Number(r.amount),
    currency: r.currency,
    created: r.createdAt.toISOString().substring(0, 16)
  })));

  // Also check all recent orders
  const r2 = await c.query(`
    SELECT id, status, "streamlinedStatus", fulfilled, "paymentStatus",
           "orderCategory", amount, currency, "createdAt"
    FROM "Orders"
    WHERE "userId" = 7
    ORDER BY "createdAt" DESC
    LIMIT 20
  `);

  console.log('\n=== Last 20 orders for user #7 ===');
  console.table(r2.rows.map(r => ({
    order: r.id,
    status: r.status,
    streamlined: r.streamlinedStatus,
    fulfilled: r.fulfilled,
    payStatus: r.paymentStatus,
    category: r.orderCategory,
    amount: Number(r.amount),
    currency: r.currency,
    created: r.createdAt.toISOString().substring(0, 16)
  })));

  await c.end();
}).catch(e => { console.error(e); process.exit(1); });
