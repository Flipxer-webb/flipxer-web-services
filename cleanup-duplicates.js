const { PrismaClient } = require("@prisma/client");

async function cleanupDuplicates() {
  const prisma = new PrismaClient();
  
  try {
    // Find duplicates
    const duplicates = await prisma.$queryRawUnsafe(`
      SELECT migration_name, COUNT(*) as cnt
      FROM "_prisma_migrations"
      GROUP BY migration_name
      HAVING COUNT(*) > 1
    `);
    
    console.log("Duplicate migrations found:");
    duplicates.forEach(d => console.log("  - " + d.migration_name + " (" + d.cnt + " copies)"));
    
    if (duplicates.length === 0) {
      console.log("  None");
      return;
    }
    
    // Remove duplicates, keeping only the first entry for each
    console.log("\nCleaning up duplicates...");
    
    for (const dup of duplicates) {
      // Get all IDs for this migration
      const rows = await prisma.$queryRawUnsafe(
        "SELECT id FROM \"_prisma_migrations\" WHERE migration_name = '" + dup.migration_name + "' ORDER BY started_at"
      );
      
      // Keep first, delete rest
      const idsToDelete = rows.slice(1).map(r => "'" + r.id + "'").join(",");
      if (idsToDelete) {
        await prisma.$queryRawUnsafe(
          "DELETE FROM \"_prisma_migrations\" WHERE id IN (" + idsToDelete + ")"
        );
        console.log("  Removed " + (rows.length - 1) + " duplicate(s) of " + dup.migration_name);
      }
    }
    
    // Verify
    const remaining = await prisma.$queryRawUnsafe(
      "SELECT COUNT(*) as total FROM \"_prisma_migrations\""
    );
    console.log("\nTotal migrations after cleanup: " + remaining[0].total);
    
  } catch (error) {
    console.error("Error:", error.message);
  } finally {
    await prisma.$disconnect();
  }
}

cleanupDuplicates();
