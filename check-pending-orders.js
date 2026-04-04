const { Client } = require('pg');
const c = new Client({
  connectionString: 'postgresql://resolve_db_user:Bje9vozyOzdFC7qxy4hybDDiSUle7Wyc@dpg-d5v3gcnpm1nc73c9q6fg-a.oregon-postgres.render.com/resolve_db_4a8l_b6ra_o5el_m1sw_p0r2_x75k_ayye',
  ssl: { rejectUnauthorized: false }
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
