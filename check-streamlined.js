require('dotenv').config();
const { Client } = require('pg');
const c = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

c.connect().then(async () => {
  const r = await c.query(`
    SELECT id, "userId", status, "streamlinedStatus", fulfilled, "ledgerEntryId",
           "orderCategory", amount, currency, "paymentStatus"
    FROM "Orders"
    WHERE id IN (9, 12, 18, 31, 34, 38, 88, 101, 385, 386)
    ORDER BY id
  `);

  console.table(r.rows.map(r => ({
    order: r.id,
    status: r.status,
    streamlined: r.streamlinedStatus,
    fulfilled: r.fulfilled,
    paymentStatus: r.paymentStatus,
    category: r.orderCategory,
    amount: Number(r.amount),
    currency: r.currency,
    ledger: r.ledgerEntryId ? r.ledgerEntryId.substring(0, 8) + '...' : null
  })));

  await c.end();
}).catch(e => { console.error(e); process.exit(1); });
