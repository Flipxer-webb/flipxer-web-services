require('dotenv').config();
const { Client } = require('pg');

const connectionString = process.env.DATABASE_URL;
const useSsl = connectionString && !/localhost|127\.0\.0\.1/.test(connectionString);

if (!connectionString) {
    console.error('Missing DATABASE_URL environment variable.');
    process.exit(1);
}

async function cleanupBotSessions() {
    const client = new Client({ connectionString, ssl: useSsl ? { rejectUnauthorized: false } : false });

    try {
        await client.connect();
        console.log('Connected to database');

        // First, get list of tables
        const tablesResult = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name");
        console.log('Tables in database:', tablesResult.rows.map(r => r.table_name).join(', '));

        // Try to find the session table (could be sessions, Session, or session)
        const sessionTable = tablesResult.rows.find(r =>
            r.table_name.toLowerCase() === 'session' ||
            r.table_name.toLowerCase() === 'sessions'
        );

        if (!sessionTable) {
            console.log('No session table found!');
            return;
        }

        const tableName = sessionTable.table_name;
        console.log('Using table:', tableName);

        // Validate table name against allowlist to prevent SQL injection
        const allowedTables = ['Session', 'session', 'Sessions', 'sessions'];
        if (!allowedTables.includes(tableName)) {
            console.error(`Invalid table name: ${tableName}`);
            return;
        }

        // Get column names
        const columnsResult = await client.query(
            'SELECT column_name FROM information_schema.columns WHERE table_name = $1',
            [tableName]
        );
        console.log('Columns:', columnsResult.rows.map(r => r.column_name).join(', '));

        const countQueries = {
            Session: 'SELECT COUNT(*) as count FROM "Session" WHERE "isActive" = true',
            session: 'SELECT COUNT(*) as count FROM "session" WHERE "isActive" = true',
            Sessions: 'SELECT COUNT(*) as count FROM "Sessions" WHERE "isActive" = true',
            sessions: 'SELECT COUNT(*) as count FROM "sessions" WHERE "isActive" = true'
        };

        const deactivateQueries = {
            Session: `
                UPDATE "Session"
                SET "isActive" = false
                WHERE "isActive" = true
                AND (
                    "ipAddress" LIKE '3.%' OR
                    "ipAddress" LIKE '13.%' OR
                    "ipAddress" LIKE '16.%' OR
                    "ipAddress" LIKE '18.%' OR
                    "ipAddress" LIKE '34.%' OR
                    "ipAddress" LIKE '35.%' OR
                    "ipAddress" LIKE '44.%' OR
                    "ipAddress" LIKE '52.%' OR
                    "ipAddress" LIKE '54.%'
                )
            `,
            session: `
                UPDATE "session"
                SET "isActive" = false
                WHERE "isActive" = true
                AND (
                    "ipAddress" LIKE '3.%' OR
                    "ipAddress" LIKE '13.%' OR
                    "ipAddress" LIKE '16.%' OR
                    "ipAddress" LIKE '18.%' OR
                    "ipAddress" LIKE '34.%' OR
                    "ipAddress" LIKE '35.%' OR
                    "ipAddress" LIKE '44.%' OR
                    "ipAddress" LIKE '52.%' OR
                    "ipAddress" LIKE '54.%'
                )
            `,
            Sessions: `
                UPDATE "Sessions"
                SET "isActive" = false
                WHERE "isActive" = true
                AND (
                    "ipAddress" LIKE '3.%' OR
                    "ipAddress" LIKE '13.%' OR
                    "ipAddress" LIKE '16.%' OR
                    "ipAddress" LIKE '18.%' OR
                    "ipAddress" LIKE '34.%' OR
                    "ipAddress" LIKE '35.%' OR
                    "ipAddress" LIKE '44.%' OR
                    "ipAddress" LIKE '52.%' OR
                    "ipAddress" LIKE '54.%'
                )
            `,
            sessions: `
                UPDATE "sessions"
                SET "isActive" = false
                WHERE "isActive" = true
                AND (
                    "ipAddress" LIKE '3.%' OR
                    "ipAddress" LIKE '13.%' OR
                    "ipAddress" LIKE '16.%' OR
                    "ipAddress" LIKE '18.%' OR
                    "ipAddress" LIKE '34.%' OR
                    "ipAddress" LIKE '35.%' OR
                    "ipAddress" LIKE '44.%' OR
                    "ipAddress" LIKE '52.%' OR
                    "ipAddress" LIKE '54.%'
                )
            `
        };

        // Count active sessions
        const countResult = await client.query(countQueries[tableName]);

        console.log('Total active sessions:', countResult.rows[0].count);

        // Deactivate bot sessions (AWS IPs)
        const deactivateResult = await client.query(deactivateQueries[tableName]);
        console.log('Bot sessions deactivated:', deactivateResult.rowCount);

        // Check remaining active sessions
        const remainingResult = await client.query(countQueries[tableName]);
        console.log('Remaining active sessions:', remainingResult.rows[0].count);

    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await client.end();
        console.log('Disconnected from database');
    }
}

cleanupBotSessions();
