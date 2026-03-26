require('dotenv').config();
const { Client } = require('pg');
const c = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

c.connect().then(async () => {
  const r = await c.query(`
    SELECT o.id, o."userId", u.email, u."firstName", u."lastName",
           o.amount, o.currency, o."orderCategory", o.status as order_status,
           o.fulfilled, o."ledgerEntryId",
           p.status as payment_status, p."paymentMethod"
    FROM "Orders" o
    JOIN "Payments" p ON p."orderId" = o.id
    JOIN "Users" u ON u.id = o."userId"
    WHERE o.id IN (9, 12, 18, 31, 34, 38, 88, 101, 385, 386)
    ORDER BY o."userId", o.id
  `);

  console.table(r.rows.map(r => ({
    order: r.id,
    userId: r.userId,
    email: r.email,
    name: (r.firstName || '') + ' ' + (r.lastName || ''),
    amount: Number(r.amount),
    currency: r.currency,
    category: r.orderCategory,
    orderStatus: r.order_status,
    fulfilled: r.fulfilled,
    payStatus: r.payment_status,
    method: r.paymentMethod,
    ledgerId: r.ledgerEntryId ? r.ledgerEntryId.substring(0, 8) + '...' : null
  })));

  const users = new Set(r.rows.map(r => r.userId));
  console.log('Unique users:', users.size, '| User IDs:', [...users].join(', '));

  // Check broken ledger orders separately
  const r2 = await c.query(`
    SELECT o.id, o."userId", u.email, o.amount, o.currency, o."orderCategory",
           o.status, o.fulfilled, o."ledgerEntryId", le.status as ledger_status
    FROM "Orders" o
    JOIN "Users" u ON u.id = o."userId"
    LEFT JOIN "LedgerEntries" le ON le.id = o."ledgerEntryId"
    WHERE o.id IN (385, 386)
  `);
  console.log('\n=== Orders #385, #386 (broken ledger check) ===');
  console.table(r2.rows.map(r => ({
    order: r.id,
    userId: r.userId,
    email: r.email,
    amount: Number(r.amount),
    currency: r.currency,
    category: r.orderCategory,
    status: r.status,
    fulfilled: r.fulfilled,
    ledgerId: r.ledgerEntryId ? r.ledgerEntryId.substring(0, 8) + '...' : null,
    ledgerStatus: r.ledger_status
  })));

  await c.end();
}).catch(e => { console.error(e); process.exit(1); });
