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
  const r = await c.query(`
    SELECT p.id, p."orderId", p.status, p."paymentStatus", p.reference,
           p."paymentConfirmedByUser", p."stuckAlertSentAt",
           p."createdAt", p."paymentMethod",
           NOW() - p."createdAt" as age
    FROM "Payments" p
    WHERE p."orderId" IN (446, 448)
    ORDER BY p."orderId"
  `);

  console.table(r.rows.map(r => ({
    payId: r.id,
    orderId: r.orderId,
    status: r.status,
    payStatus: r.paymentStatus,
    reference: r.reference,
    confirmed: r.paymentConfirmedByUser,
    stuckAlert: r.stuckAlertSentAt,
    method: r.paymentMethod,
    created: r.createdAt.toISOString().substring(0, 19),
    age: r.age
  })));

  await c.end();
}).catch(e => { console.error(e); process.exit(1); });
