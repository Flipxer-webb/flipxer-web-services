const { PrismaClient } = require("@prisma/client");

async function checkMigrations() {
  const prisma = new PrismaClient();
  
  try {
    const migrations = await prisma.$queryRawUnsafe(
      "SELECT migration_name, finished_at FROM \"_prisma_migrations\" ORDER BY started_at"
    );
    
    console.log("Migrations recorded in database (" + migrations.length + " total):\n");
    migrations.forEach((m, i) => {
      console.log((i+1) + ". " + m.migration_name);
    });
    
  } catch (error) {
    console.error("Error:", error.message);
  } finally {
    await prisma.$disconnect();
  }
}

checkMigrations();
