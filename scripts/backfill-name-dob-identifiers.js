/**
 * Backfill script: Create NAME_DOB IdentityIdentifier records for all
 * existing verified users who already have an IdentitySubject.
 *
 * This adds the biographic cross-check hash (firstName|lastName|DOB)
 * so that the same person using BVN on one account and NIN on another
 * can be detected.
 *
 * Usage:
 *   DRY_RUN=true  node scripts/backfill-name-dob-identifiers.js   # preview only
 *   DRY_RUN=false node scripts/backfill-name-dob-identifiers.js   # apply changes
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

function normalizeDateOfBirth(raw) {
    const cleaned = raw.trim();
    // YYYY-MM-DD or YYYY/MM/DD
    const isoMatch = cleaned.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (isoMatch) {
        return `${isoMatch[1]}-${isoMatch[2].padStart(2, "0")}-${isoMatch[3].padStart(2, "0")}`;
    }
    // DD-MM-YYYY or DD/MM/YYYY
    const dmyMatch = cleaned.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (dmyMatch) {
        return `${dmyMatch[3]}-${dmyMatch[2].padStart(2, "0")}-${dmyMatch[1].padStart(2, "0")}`;
    }
    return cleaned;
}

function hashBiographic(firstName, lastName, dateOfBirth) {
    const normFirst = firstName.trim().toUpperCase();
    const normLast = lastName.trim().toUpperCase();
    const sortedNames = [normFirst, normLast].sort();
    const normDob = normalizeDateOfBirth(dateOfBirth);
    const composite = `${sortedNames[0]}|${sortedNames[1]}|${normDob}`;
    return crypto.createHash("sha256").update(composite).digest("hex");
}

async function main() {
    console.log(`=== NAME_DOB Identifier Backfill (DRY_RUN=${DRY_RUN}) ===\n`);

    // Find all users with identity subjects who have name + DOB data
    const users = await prisma.user.findMany({
        where: {
            identitySubjectId: { not: null },
            firstName: { not: null },
            lastName: { not: null },
            dateOfBirth: { not: null },
        },
        select: {
            id: true,
            firstName: true,
            lastName: true,
            dateOfBirth: true,
            identitySubjectId: true,
        },
    });

    console.log(`Found ${users.length} users with identity subjects and biographic data.\n`);

    let created = 0;
    let skipped = 0;
    const conflicts = [];

    for (const user of users) {
        const dobStr = user.dateOfBirth.toISOString().split("T")[0];
        const hash = hashBiographic(user.firstName, user.lastName, dobStr);
        const maskedName = `${user.firstName.charAt(0)}***${user.lastName.charAt(0)}***`;

        // Check if NAME_DOB identifier already exists
        const existing = await prisma.identityIdentifier.findUnique({
            where: { type_valueHash: { type: "NAME_DOB", valueHash: hash } },
            include: { subject: { include: { user: { select: { id: true } } } } },
        });

        if (existing) {
            if (existing.subjectId === user.identitySubjectId) {
                // Already has this exact identifier
                skipped++;
                continue;
            }
            // Different subject → conflict (same person, different accounts)
            conflicts.push({
                userId: user.id,
                name: `${user.firstName} ${user.lastName}`,
                dob: dobStr,
                subjectId: user.identitySubjectId,
                conflictsWithUser: existing.subject?.user?.id || "orphan",
                conflictsWithSubject: existing.subjectId,
            });
            continue;
        }

        if (DRY_RUN) {
            console.log(
                `[DRY RUN] Would create NAME_DOB for user ${user.id} (${maskedName}, subject ${user.identitySubjectId})`,
            );
            created++;
        } else {
            await prisma.identityIdentifier.create({
                data: {
                    subjectId: user.identitySubjectId,
                    type: "NAME_DOB",
                    valueHash: hash,
                    maskedValue: maskedName,
                    verifiedAt: new Date(),
                },
            });
            console.log(
                `Created NAME_DOB for user ${user.id} (${maskedName}, subject ${user.identitySubjectId})`,
            );
            created++;
        }
    }

    console.log(`\n=== Summary ===`);
    console.log(`Created: ${created}`);
    console.log(`Skipped (already exists): ${skipped}`);
    console.log(`Conflicts: ${conflicts.length}`);

    if (conflicts.length > 0) {
        console.log(`\n=== CONFLICTS — Same person, different accounts ===`);
        for (const c of conflicts) {
            console.log(
                `  User ${c.userId} (${c.name}, DOB ${c.dob}, subject ${c.subjectId}) ` +
                `conflicts with user ${c.conflictsWithUser} (subject ${c.conflictsWithSubject})`,
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
