const { Client } = require('pg');

const connectionString = 'postgresql://resolve_db_user:Bje9vozyOzdFC7qxy4hybDDiSUle7Wyc@dpg-d575e4mr433s73egl6p0-a.oregon-postgres.render.com/resolve_db_4a8l_b6ra';

async function cleanupBotSessions() {
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });

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
        // Sanitize table name (remove any non-alphanumeric chars except underscore)
        const safeTableName = tableName.replace(/[^a-zA-Z0-9_]/g, '');

        // Get column names
        const columnsResult = await client.query(
            'SELECT column_name FROM information_schema.columns WHERE table_name = $1',
            [safeTableName]
        );
        console.log('Columns:', columnsResult.rows.map(r => r.column_name).join(', '));

        // Count active sessions
        const countResult = await client.query(`SELECT COUNT(*) as count FROM "${safeTableName}" WHERE "isActive" = true`);

        console.log('Total active sessions:', countResult.rows[0].count);

        // Deactivate bot sessions (AWS IPs)
        const deactivateQuery = `
            UPDATE "${safeTableName}" 
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
        `;
        const deactivateResult = await client.query(deactivateQuery);
        console.log('Bot sessions deactivated:', deactivateResult.rowCount);

        // Check remaining active sessions
        const remainingResult = await client.query(`SELECT COUNT(*) as count FROM "${safeTableName}" WHERE "isActive" = true`);
        console.log('Remaining active sessions:', remainingResult.rows[0].count);

    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await client.end();
        console.log('Disconnected from database');
    }
}

cleanupBotSessions();
