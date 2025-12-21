/**
 * Direct SQL migration for WebAuthn and Trusted Device features
 * Run with: node apply-webauthn-migration.js
 * 
 * This script adds:
 * 1. WebAuthnCredentials table for passkey storage
 * 2. Trusted device fields to Sessions table  
 * 3. skipTwoFactorForTrustedDevices field to Users table
 */

const { Client } = require('pg');
require('dotenv').config();

async function applyMigration() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 60000,
    query_timeout: 60000,
  });

  try {
    console.log('Connecting to database...');
    await client.connect();
    console.log('Connected successfully!');

    // Check if WebAuthnCredentials table already exists
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'WebAuthnCredentials'
      );
    `);

    if (tableCheck.rows[0].exists) {
      console.log('WebAuthnCredentials table already exists. Checking for missing columns...');
    } else {
      console.log('Creating WebAuthnCredentials table...');
      await client.query(`
        CREATE TABLE "WebAuthnCredentials" (
          "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
          "userId" INTEGER NOT NULL,
          "credentialId" TEXT NOT NULL,
          "publicKey" TEXT NOT NULL,
          "counter" BIGINT NOT NULL DEFAULT 0,
          "deviceType" TEXT,
          "deviceName" TEXT,
          "transports" TEXT,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "lastUsedAt" TIMESTAMP(3),

          CONSTRAINT "WebAuthnCredentials_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "WebAuthnCredentials_userId_fkey" FOREIGN KEY ("userId") 
            REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE
        );
      `);
      console.log('✅ WebAuthnCredentials table created');

      // Create unique index on credentialId
      await client.query(`
        CREATE UNIQUE INDEX "WebAuthnCredentials_credentialId_key" 
        ON "WebAuthnCredentials"("credentialId");
      `);
      console.log('✅ Created unique index on credentialId');

      // Create index on userId
      await client.query(`
        CREATE INDEX "WebAuthnCredentials_userId_idx" 
        ON "WebAuthnCredentials"("userId");
      `);
      console.log('✅ Created index on userId');

      // Create index on credentialId for lookups
      await client.query(`
        CREATE INDEX "WebAuthnCredentials_credentialId_idx" 
        ON "WebAuthnCredentials"("credentialId");
      `);
      console.log('✅ Created index on credentialId for lookups');
    }

    // Add Session trusted device fields
    console.log('\nChecking Session table for trusted device fields...');

    const sessionColumns = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'Sessions' 
      AND column_name IN ('deviceToken', 'isTrusted', 'trustedAt', 'trustExpiresAt');
    `);

    const existingColumns = sessionColumns.rows.map(r => r.column_name);

    if (!existingColumns.includes('deviceToken')) {
      await client.query(`ALTER TABLE "Sessions" ADD COLUMN "deviceToken" TEXT;`);
      console.log('✅ Added deviceToken column to Sessions');
      
      await client.query(`CREATE INDEX "Sessions_deviceToken_idx" ON "Sessions"("deviceToken");`);
      console.log('✅ Created index on deviceToken');
    } else {
      console.log('deviceToken column already exists');
    }

    if (!existingColumns.includes('isTrusted')) {
      await client.query(`ALTER TABLE "Sessions" ADD COLUMN "isTrusted" BOOLEAN NOT NULL DEFAULT false;`);
      console.log('✅ Added isTrusted column to Sessions');
    } else {
      console.log('isTrusted column already exists');
    }

    if (!existingColumns.includes('trustedAt')) {
      await client.query(`ALTER TABLE "Sessions" ADD COLUMN "trustedAt" TIMESTAMP(3);`);
      console.log('✅ Added trustedAt column to Sessions');
    } else {
      console.log('trustedAt column already exists');
    }

    if (!existingColumns.includes('trustExpiresAt')) {
      await client.query(`ALTER TABLE "Sessions" ADD COLUMN "trustExpiresAt" TIMESTAMP(3);`);
      console.log('✅ Added trustExpiresAt column to Sessions');
    } else {
      console.log('trustExpiresAt column already exists');
    }

    // Add User skipTwoFactorForTrustedDevices field
    console.log('\nChecking Users table for skipTwoFactorForTrustedDevices field...');

    const userColumns = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'Users' 
      AND column_name = 'skipTwoFactorForTrustedDevices';
    `);

    if (userColumns.rows.length === 0) {
      await client.query(`
        ALTER TABLE "Users" 
        ADD COLUMN "skipTwoFactorForTrustedDevices" BOOLEAN NOT NULL DEFAULT false;
      `);
      console.log('✅ Added skipTwoFactorForTrustedDevices column to Users');
    } else {
      console.log('skipTwoFactorForTrustedDevices column already exists');
    }

    // Record migration in _prisma_migrations table
    console.log('\nRecording migration...');
    const migrationName = '20251221000001_add_webauthn_and_trusted_devices';
    
    const migrationExists = await client.query(`
      SELECT id FROM "_prisma_migrations" WHERE migration_name = $1;
    `, [migrationName]);

    if (migrationExists.rows.length === 0) {
      await client.query(`
        INSERT INTO "_prisma_migrations" (
          id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count
        ) VALUES (
          gen_random_uuid()::text,
          'manual_migration_webauthn_trusted_devices',
          NOW(),
          $1,
          'Applied via apply-webauthn-migration.js',
          NULL,
          NOW(),
          1
        );
      `, [migrationName]);
      console.log('✅ Migration recorded in _prisma_migrations');
    } else {
      console.log('Migration already recorded');
    }

    console.log('\n========================================');
    console.log('✅ Migration completed successfully!');
    console.log('========================================');
    console.log('\nNew schema additions:');
    console.log('- WebAuthnCredentials table for passkey storage');
    console.log('- Sessions: deviceToken, isTrusted, trustedAt, trustExpiresAt');
    console.log('- Users: skipTwoFactorForTrustedDevices');

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    console.error(error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

applyMigration();
