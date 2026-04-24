// One-time cleanup: removes @flipxer.com test users so re-seed with @flipxer.local works
// Run: node prisma/scripts/cleanup-legacy-test-users.js
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const LEGACY_EMAILS = [
    "tier0.test@flipxer.com",
    "tier1.test@flipxer.com",
    "tier2.test@flipxer.com",
    "tier3.test@flipxer.com",
    "blocked.test@flipxer.com",
    "locked.test@flipxer.com",
    "twofactor.test@flipxer.com",
    "kyc-pending.test@flipxer.com",
    "kyc-declined.test@flipxer.com",
    "business.test@flipxer.com",
    "superadmin.test@flipxer.com",
];

prisma.user
    .deleteMany({ where: { email: { in: LEGACY_EMAILS } } })
    .then((r) => console.log(`Deleted ${r.count} legacy test users`))
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
