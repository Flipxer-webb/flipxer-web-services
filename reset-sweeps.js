const { Client } = require("pg");

const c = new Client({
  connectionString:
    "postgresql://resolve_db_user:Bje9vozyOzdFC7qxy4hybDDiSUle7Wyc@dpg-d5v3gcnpm1nc73c9q6fg-a.oregon-postgres.render.com/resolve_db_4a8l_b6ra_o5el_m1sw_p0r2_x75k_ayye",
  ssl: { rejectUnauthorized: false },
});

async function main() {
  await c.connect();

  const res = await c.query(`
    UPDATE "LedgerEntries"
    SET "sweepStatus" = 'COMPLETED',
        "updatedAt" = NOW()
    WHERE "id" IN (
      '7f3b76bc-fefc-4f97-afd6-47fa836569d6',
      'cbc5dbcd-1282-47cd-bd75-d0685eb98f2f',
      '7b717f09-d182-4657-b23b-96e2aac6c710'
    )
    RETURNING "id", "userId", "currency", "credit"::text, "sweepStatus"
  `);

  console.log(`Updated ${res.rowCount} entries:`);
  for (const row of res.rows) {
    console.log(JSON.stringify(row));
  }

  await c.end();
}

main().catch((e) => {
  console.error(e);
  c.end();
  process.exit(1);
});
