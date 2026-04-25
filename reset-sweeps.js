require('dotenv').config();
const { Client } = require("pg");

const connectionString = process.env.DATABASE_URL;
const useSsl = connectionString && !/localhost|127\.0\.0\.1/.test(connectionString);

if (!connectionString) {
  console.error('Missing DATABASE_URL environment variable.');
  process.exit(1);
}

const c = new Client({
  connectionString,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
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
