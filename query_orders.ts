import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    try {
        const schemas = await prisma.$queryRaw`
      SELECT schema_name 
      FROM information_schema.schemata
    `;
        console.log('Schemas:', JSON.stringify(schemas, null, 2));

        const tables = await prisma.$queryRaw`
      SELECT table_schema, table_name 
      FROM information_schema.tables 
      WHERE table_type = 'BASE TABLE'
    `;
        console.log('All Tables:', JSON.stringify(tables, null, 2));

    } catch (error) {
        console.error('Error:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
