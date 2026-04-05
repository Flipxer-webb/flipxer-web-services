const { PrismaClient } = require("@prisma/client");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const allMigrations = [
  "20250303193222_initial_setup",
  "20250308072600_user_data",
  "20250407131544_added_bank_details",
  "20250408143617_recovery_email",
  "20250523110538_add_a_field",
  "20250602140716_drop_recovery_email",
  "20250618145127_name",
  "20250619125503_add_photo_file_id_to_user",
  "20250806193856_create_allowed_ips",
  "20250807213454_removed_flagged_id",
  "20250807213554_added_back_flagged_id",
  "20250928200000_update_network_types_enum",
  "20250928204034_update_network_type_again",
  "20250929141155_remove_test_enum_for_network_type",
  "20251210170000_add_nin_fields",
  "20251219000001_add_two_factor_backup_codes",
  "20251221000001_add_multi_factor_security_fields",
  "20251222000001_drop_biometric_credentials",
  "20251223000001_add_missing_user_columns",
  "20251224000001_add_performance_indexes",
  "20260105003000_add_fulfilled_to_order",
  "20260112172309_virtual_balance_ledger_system",
  "20260112174917_add_ledger_entry_enums_fix"
];

async function fixMigrations() {
  const prisma = new PrismaClient();
  
  try {
    // Step 1: Kill all advisory locks
    console.log("Step 1: Killing advisory locks...");
    const locks = await prisma.$queryRawUnsafe(
      "SELECT DISTINCT pid FROM pg_locks WHERE locktype = 'advisory'"
    );
    const myPid = await prisma.$queryRawUnsafe("SELECT pg_backend_pid() as pid");
    
    for (const lock of locks) {
      if (lock.pid !== myPid[0].pid) {
        await prisma.$queryRawUnsafe("SELECT pg_terminate_backend(" + lock.pid + ")");
        console.log("  Terminated PID " + lock.pid);
      }
    }
    console.log("  Done\n");
    
    // Step 2: Create _prisma_migrations table if not exists
    console.log("Step 2: Creating _prisma_migrations table...");
    await prisma.$queryRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
        "id" VARCHAR(36) PRIMARY KEY,
        "checksum" VARCHAR(64) NOT NULL,
        "finished_at" TIMESTAMPTZ,
        "migration_name" VARCHAR(255) NOT NULL,
        "logs" TEXT,
        "rolled_back_at" TIMESTAMPTZ,
        "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "applied_steps_count" INTEGER NOT NULL DEFAULT 0
      )
    `);
    console.log("  Done\n");
    
    // Step 3: Insert all migrations
    console.log("Step 3: Baselining " + allMigrations.length + " migrations...");
    
    for (const migration of allMigrations) {
      const migrationPath = path.join("prisma", "migrations", migration, "migration.sql");
      
      let checksum = "";
      try {
        const content = fs.readFileSync(migrationPath, "utf8");
        checksum = crypto.createHash("sha256").update(content).digest("hex");
      } catch (e) {
        checksum = crypto.createHash("sha256").update(migration).digest("hex");
      }
      
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      
      try {
        const existing = await prisma.$queryRawUnsafe(
          "SELECT id FROM \"_prisma_migrations\" WHERE migration_name = '" + migration + "'"
        );
        
        if (existing.length > 0) {
          console.log("  [skip] " + migration);
          continue;
        }
        
        await prisma.$queryRawUnsafe(
          "INSERT INTO \"_prisma_migrations\" (id, checksum, migration_name, logs, started_at, finished_at, applied_steps_count) VALUES ('" + 
          id + "', '" + checksum + "', '" + migration + "', NULL, '" + now + "', '" + now + "', 1)"
        );
        console.log("  [ok] " + migration);
      } catch (e) {
        console.log("  [err] " + migration + ": " + e.message.substring(0, 50));
      }
    }
    
    console.log("\nDone! All migrations baselined.");
    
  } catch (error) {
    console.error("Error:", error.message);
  } finally {
    await prisma.$disconnect();
  }
}

fixMigrations();
