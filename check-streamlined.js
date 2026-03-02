const { Client } = require('pg');
const c = new Client({
  connectionString: 'postgresql://resolve_db_user:Bje9vozyOzdFC7qxy4hybDDiSUle7Wyc@dpg-d5v3gcnpm1nc73c9q6fg-a.oregon-postgres.render.com/resolve_db_4a8l_b6ra_o5el_m1sw_p0r2_x75k_ayye',
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
