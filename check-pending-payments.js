const { Client } = require('pg');
const c = new Client({
  connectionString: 'postgresql://resolve_db_user:Bje9vozyOzdFC7qxy4hybDDiSUle7Wyc@dpg-d5v3gcnpm1nc73c9q6fg-a.oregon-postgres.render.com/resolve_db_4a8l_b6ra_o5el_m1sw_p0r2_x75k_ayye',
  ssl: { rejectUnauthorized: false }
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
