/**
 * Backfill script: Create IdentitySubject + IdentityIdentifier records
 * for all existing users with verified BVN or NIN.
 *
 * Usage:
 *   DRY_RUN=true  node scripts/backfill-identity-subjects.js   # preview only
 *   DRY_RUN=false node scripts/backfill-identity-subjects.js   # apply changes
 *
 * Requires DATABASE_URL env var.
 */

const { PrismaClient } = require("@prisma/client");
const crypto = require("node:crypto");

const dbUrl = process.env.DATABASE_URL;
const prisma = new PrismaClient(
    dbUrl ? { datasources: { db: { url: dbUrl } } } : undefined,
);
const DRY_RUN = process.env.DRY_RUN !== "false";

function hashIdentifier(rawValue) {
    return crypto
        .createHash("sha256")
        .update(rawValue.trim().toLowerCase())
        .digest("hex");
}

function maskIdentifier(rawValue) {
    if (rawValue.length <= 4) return rawValue;
    const first2 = rawValue.slice(0, 2);
    const last2 = rawValue.slice(-2);
    const masked = "*".repeat(rawValue.length - 4);
    return `${first2}${masked}${last2}`;
}

async function main() {
    console.log(`=== Identity Subject Backfill (DRY_RUN=${DRY_RUN}) ===\n`);

    const users = await prisma.user.findMany({
        where: {
            OR: [
                { isBvnVerified: true, bvn: { not: null } },
                { isNinVerified: true, nin: { not: null } },
            ],
        },
        select: {
            id: true,
            bvn: true,
            nin: true,
            isBvnVerified: true,
            isNinVerified: true,
            identitySubjectId: true,
        },
    });

    console.log(`Found ${users.length} users with verified BVN or NIN.\n`);

    let created = 0;
    let skipped = 0;
    const conflicts = [];

    for (const user of users) {
        // Skip if user already has a subject
        if (user.identitySubjectId) {
            skipped++;
            continue;
        }

        const identifiers = [];

        if (user.isBvnVerified && user.bvn) {
            const hash = hashIdentifier(user.bvn);
            // Check for conflicts
            const existing = await prisma.identityIdentifier.findUnique({
                where: { type_valueHash: { type: "BVN", valueHash: hash } },
                include: { subject: { include: { user: { select: { id: true } } } } },
            });
            if (existing) {
                conflicts.push({
                    userId: user.id,
                    type: "BVN",
                    maskedValue: maskIdentifier(user.bvn),
                    conflictsWith: existing.subject?.user?.id || "orphan",
                });
            } else {
                identifiers.push({ type: "BVN", valueHash: hash, maskedValue: maskIdentifier(user.bvn) });
            }
        }

        if (user.isNinVerified && user.nin) {
            const hash = hashIdentifier(user.nin);
            const existing = await prisma.identityIdentifier.findUnique({
                where: { type_valueHash: { type: "NIN", valueHash: hash } },
                include: { subject: { include: { user: { select: { id: true } } } } },
            });
            if (existing) {
                conflicts.push({
                    userId: user.id,
                    type: "NIN",
                    maskedValue: maskIdentifier(user.nin),
                    conflictsWith: existing.subject?.user?.id || "orphan",
                });
            } else {
                identifiers.push({ type: "NIN", valueHash: hash, maskedValue: maskIdentifier(user.nin) });
            }
        }

        if (identifiers.length === 0) {
            skipped++;
            continue;
        }

        if (DRY_RUN) {
            console.log(
                `[DRY RUN] Would create subject for user ${user.id} with ${identifiers.length} identifier(s): ${identifiers.map((i) => i.type).join(", ")}`,
            );
            created++;
        } else {
            await prisma.$transaction(async (tx) => {
                const subject = await tx.identitySubject.create({ data: {} });
                for (const id of identifiers) {
                    await tx.identityIdentifier.create({
                        data: {
                            subjectId: subject.id,
                            type: id.type,
                            valueHash: id.valueHash,
                            maskedValue: id.maskedValue,
                            verifiedAt: new Date(),
                        },
                    });
                }
                await tx.user.update({
                    where: { id: user.id },
                    data: { identitySubjectId: subject.id },
                });
            });
            console.log(
                `Created subject for user ${user.id} (${identifiers.map((i) => i.type).join(", ")})`,
            );
            created++;
        }
    }

    console.log(`\n=== Summary ===`);
    console.log(`Created: ${created}`);
    console.log(`Skipped (already linked): ${skipped}`);
    console.log(`Conflicts: ${conflicts.length}`);

    if (conflicts.length > 0) {
        console.log(`\n=== Conflicts (require manual review) ===`);
        for (const c of conflicts) {
            console.log(
                `  User ${c.userId} → ${c.type} (${c.maskedValue}) conflicts with user ${c.conflictsWith}`,
            );
        }
    }
}

main()
    .catch((e) => {
        console.error("Backfill failed:", e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
