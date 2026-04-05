const { PrismaClient } = require("@prisma/client");

async function checkUsers() {
  const prisma = new PrismaClient();
  
  try {
    const count = await prisma.$queryRawUnsafe(
      "SELECT COUNT(*) as total FROM \"Users\""
    );
    console.log("Total users in database: " + count[0].total);
    
    // Get a few recent users to verify data
    const recent = await prisma.$queryRawUnsafe(
      "SELECT id, email, \"createdAt\" FROM \"Users\" ORDER BY \"createdAt\" DESC LIMIT 5"
    );
    console.log("\nMost recent users:");
    recent.forEach(u => console.log("  - " + u.email + " (created: " + u.createdAt + ")"));
    
  } catch (error) {
    console.error("Error:", error.message);
  } finally {
    await prisma.$disconnect();
  }
}

checkUsers();
