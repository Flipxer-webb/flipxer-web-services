const { PrismaClient } = require("@prisma/client");

async function checkLocks() {
  const prisma = new PrismaClient();
  
  try {
    const locks = await prisma.$queryRawUnsafe(
      "SELECT pid, mode, granted FROM pg_locks WHERE locktype = 'advisory'"
    );
    
    if (locks.length === 0) {
      console.log("No advisory locks found.");
    } else {
      console.log("Advisory locks found:");
      locks.forEach(l => console.log("  PID " + l.pid + " - mode: " + l.mode + " - granted: " + l.granted));
    }
    
  } catch (error) {
    console.error("Error:", error.message);
  } finally {
    await prisma.$disconnect();
  }
}

checkLocks();
