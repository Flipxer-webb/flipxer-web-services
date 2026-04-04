const { Client } = require('pg');

const client = new Client({
  connectionString: 'postgresql://resolve_db_user:Bje9vozyOzdFC7qxy4hybDDiSUle7Wyc@dpg-d538qter433s73c6evk0-a.oregon-postgres.render.com/resolve_db_4a8l',
  ssl: { rejectUnauthorized: false }
});

async function main() {
  try {
    console.log('Connecting...');
    await client.connect();
    console.log('Connected!');
    
    // List all tables
    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    );
    console.log('Tables in database:', tables.rows.map(r => r.table_name));
    
    // Find user
    const userResult = await client.query(
      `SELECT id, email, "isDocumentVerified" FROM "Users" WHERE email = $1`,
      ['magpiep18@gmail.com']
    );
    console.log('User:', userResult.rows[0]);
    
    if (userResult.rows.length > 0) {
      const userId = userResult.rows[0].id;
      
      // Delete document
      const deleteResult = await client.query(
        `DELETE FROM "UserDocuments" WHERE "userId" = $1`,
        [userId]
      );
      console.log('Documents deleted:', deleteResult.rowCount);
      
      // Reset verification
      const updateResult = await client.query(
        `UPDATE "Users" SET "isDocumentVerified" = false WHERE id = $1`,
        [userId]
      );
      console.log('User updated:', updateResult.rowCount);
      
      // Verify
      const verifyResult = await client.query(
        `SELECT id, email, "isDocumentVerified" FROM "Users" WHERE id = $1`,
        [userId]
      );
      console.log('Final status:', verifyResult.rows[0]);
    }
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await client.end();
  }
}

main();
