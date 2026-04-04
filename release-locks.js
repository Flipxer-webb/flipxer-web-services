const { PrismaClient } = require("@prisma/client");

async function releaseLocks() {
  const prisma = new PrismaClient();
  
  try {
    const locks = await prisma.$queryRawUnsafe(
      "SELECT DISTINCT pid FROM pg_locks WHERE locktype = 'advisory'"
    );
    const myPid = await prisma.$queryRawUnsafe("SELECT pg_backend_pid() as pid");
    
    console.log("Releasing advisory locks...");
    for (const lock of locks) {
      if (lock.pid !== myPid[0].pid) {
        await prisma.$queryRawUnsafe("SELECT pg_terminate_backend(" + lock.pid + ")");
        console.log("  Terminated PID " + lock.pid);
      }
    }
    
    const remaining = await prisma.$queryRawUnsafe(
      "SELECT pid FROM pg_locks WHERE locktype = 'advisory'"
    );
    
    if (remaining.length === 0) {
      console.log("\nAll advisory locks cleared.");
    } else {
      console.log("\nRemaining locks: " + remaining.length);
    }
    
  } catch (error) {
    console.error("Error:", error.message);
  } finally {
    await prisma.$disconnect();
  }
}

releaseLocks();
