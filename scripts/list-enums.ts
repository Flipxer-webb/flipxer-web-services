/**
 * Quick enum check script
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('Checking all enums in database:\n');

    const enums = await prisma.$queryRaw<any[]>`
        SELECT DISTINCT t.typname as enum_name
        FROM pg_type t 
        JOIN pg_enum e ON t.oid = e.enumtypid 
        ORDER BY t.typname
    `;

    for (const enumType of enums) {
        const values = await prisma.$queryRaw<any[]>`
            SELECT e.enumlabel 
            FROM pg_type t 
            JOIN pg_enum e ON t.oid = e.enumtypid 
            WHERE t.typname = ${enumType.enum_name}
            ORDER BY e.enumsortorder
        `;
        console.log(`${enumType.enum_name}: ${values.map(v => v.enumlabel).join(', ')}`);
    }

    await prisma.$disconnect();
}

main();
