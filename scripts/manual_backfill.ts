
import { PrismaClient, EntryStatus, AuditAction } from '@prisma/client';

async function main() {
    const prisma = new PrismaClient();
    console.log('Connected to database...');

    try {
        const limit = 1000;
        console.log(`Searching for entries without audit logs (limit: ${limit})...`);

        // Find entries with NO audit logs
        const entries = await prisma.ledgerEntry.findMany({
            where: {
                auditLogs: {
                    none: {}
                }
            },
            take: limit,
            orderBy: { createdAt: 'desc' }
        });

        console.log(`Found ${entries.length} entries to backfill.`);

        let count = 0;
        for (const entry of entries) {
            let action: AuditAction;

            if (entry.status === EntryStatus.HOLD) {
                action = AuditAction.HOLD_PLACED;
            } else if (entry.status === EntryStatus.CANCELLED) {
                action = AuditAction.CANCELLED;
            } else if (entry.status === EntryStatus.FAILED) {
                action = AuditAction.FAILED;
            } else {
                action = AuditAction.CREATED;
            }

            await prisma.ledgerAuditLog.create({
                data: {
                    ledgerEntryId: entry.id,
                    action,
                    actor: 'system:backfill',
                    reason: 'Backfilled audit log',
                    createdAt: entry.createdAt // Backdate
                }
            });
            count++;
            if (count % 100 === 0) process.stdout.write('.');
        }

        console.log(`\nSuccessfully backfilled ${count} audit logs.`);

    } catch (e) {
        console.error('Error during backfill:', e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
