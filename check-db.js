const { PrismaClient } = require("@prisma/client");

async function checkDb() {
  const prisma = new PrismaClient();
  
  try {
    // Check migrations table
    console.log("--- _prisma_migrations table ---\n");
    try {
      const migrations = await prisma.$queryRawUnsafe(
        "SELECT migration_name, finished_at FROM \"_prisma_migrations\" ORDER BY started_at"
      );
      if (migrations.length === 0) {
        console.log("Table exists but is empty");
      } else {
        console.log("Found " + migrations.length + " migration records:");
        migrations.forEach(m => console.log("  - " + m.migration_name));
      }
    } catch (e) {
      console.log("Table does not exist or error: " + e.message.substring(0, 80));
    }
    
    // Check locks
    console.log("\n--- Advisory locks ---\n");
    const locks = await prisma.$queryRawUnsafe(
      "SELECT pid, mode, granted FROM pg_locks WHERE locktype = 'advisory'"
    );
    if (locks.length === 0) {
      console.log("No advisory locks");
    } else {
      console.log("Found " + locks.length + " locks:");
      locks.forEach(l => console.log("  PID " + l.pid + " - granted: " + l.granted));
    }
    
  } catch (error) {
    console.error("Error:", error.message);
  } finally {
    await prisma.$disconnect();
  }
}

checkDb();
