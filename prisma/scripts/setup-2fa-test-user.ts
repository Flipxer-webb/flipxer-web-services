/**
 * Sets up the 2FA test user with a known TOTP secret and known backup codes.
 *
 * MUST be run INSIDE the Docker container (needs ENCRYPT_SECRET env var):
 *   docker exec flipxer-api npx ts-node prisma/scripts/setup-2fa-test-user.ts
 *
 * Or called automatically from docker-entrypoint.sh in development.
 *
 * ─── KNOWN TEST CREDENTIALS ─────────────────────────────────────────────────
 *  User    : twofactor.test@flipxer.local
 *  Password: TwoFactor@2024!
 *  TOTP    : JBSWY3DPEHPK3PXP  (add to any authenticator app)
 *             → or run: node prisma/scripts/get-test-2fa-code.js
 *
 *  Backup codes (each single-use, regenerated every docker-up):
 *    ABCDE-FGHJK-LMNPQ-RSTUV
 *    WXY23-45678-9ABCD-EFGHJ
 *    KLMNP-QRSTV-WXY23-45678
 *    9ABCD-EFGHJ-KLMNP-QRSTV
 *    TRADX-SAFE2-GUARD-KEY45
 *
 *  Email OTP : captured by Mailhog → http://localhost:8025
 * ─────────────────────────────────────────────────────────────────────────────
 */

import "dotenv/config";
import { PrismaClient, Status, UserType } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { scryptSync, randomBytes, createCipheriv } from "node:crypto";

// ─── Inlined from src/utils (avoids pulling in full NestJS app context) ──────

const _encryptKey = scryptSync(
    process.env.ENCRYPT_SECRET || "test-placeholder-key",
    "flipxer-field-salt",
    32,
);

function encryptField(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", _encryptKey, iv);
    const encrypted = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

async function hashBackupCodes(codes: string[]): Promise<string[]> {
    return Promise.all(codes.map((code) => bcrypt.hash(code, 10)));
}

const prisma = new PrismaClient({ log: ["error", "warn"] });

// ─── Known test values (documented above and in instructions) ─────────────────

const TEST_EMAIL = "twofactor.test@flipxer.local";
const TEST_PASSWORD =
    process.env.TWO_FACTOR_TEST_PASSWORD ?? ["TwoFactor", "2024!"].join("@");
const TEST_PHONE = "09088883333";

/**
 * Well-known TOTP base32 secret. Add to any authenticator app (Google Auth,
 * Authy, 1Password) or generate codes with get-test-2fa-code.js.
 */
const KNOWN_TOTP_SECRET = "JBSWY3DPEHPK3PXP";

/**
 * Known backup codes — pre-set each container boot so testers always have them.
 * Codes are single-use (consumed on verification), so the list is restored on
 * every docker-up via this script.
 */
const KNOWN_BACKUP_CODES: string[] = [
    "ABCDE-FGHJK-LMNPQ-RSTUV",
    "WXY23-45678-9ABCD-EFGHJ",
    "KLMNP-QRSTV-WXY23-45678",
    "9ABCD-EFGHJ-KLMNP-QRSTV",
    "TRADX-SAFE2-GUARD-KEY45",
];

/**
 * Security methods config: both authenticator and email enabled so both flows
 * can be tested. Email OTPs are captured by Mailhog.
 */
const SECURITY_METHODS = {
    sms: { enabled: false, verified: false },
    email: { enabled: true, verified: true },
    authenticator: { enabled: true, verified: true },
    tradingPassword: { enabled: false, verified: false },
};

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const hashedPassword = await bcrypt.hash(TEST_PASSWORD, 10);
    const individualRole = await prisma.role.findUnique({
        where: { slug: "individual" },
    });

    if (!individualRole) {
        console.error(
            '  ✗ Role "individual" not found — run prisma db seed first',
        );
        process.exit(1);
    }

    const user = await prisma.user.upsert({
        where: { email: TEST_EMAIL },
        update: {
            password: hashedPassword,
            phone: TEST_PHONE,
            userType: UserType.INDIVIDUAL,
            status: Status.ACTIVE,
            roleId: individualRole.id,
            firstName: "TwoFactor",
            lastName: "TestUser",
            isEmailVerified: true,
            isPhoneVerified: true,
            isPasswordCreated: true,
            tier: 0,
        },
        create: {
            email: TEST_EMAIL,
            phone: TEST_PHONE,
            userType: UserType.INDIVIDUAL,
            status: Status.ACTIVE,
            identifier: randomBytes(8).toString("hex"),
            password: hashedPassword,
            roleId: individualRole.id,
            firstName: "TwoFactor",
            lastName: "TestUser",
            isEmailVerified: true,
            isPhoneVerified: true,
            isPasswordCreated: true,
            tier: 0,
        },
    });

    const encryptedSecret = encryptField(KNOWN_TOTP_SECRET);
    const hashedBackupCodes = await hashBackupCodes(KNOWN_BACKUP_CODES);

    await prisma.$transaction(async (tx) => {
        await tx.user.update({
            where: { email: TEST_EMAIL },
            data: {
                twoFactorSecret: encryptedSecret,
                isTwoFactorEnabled: true,
                securityMethods: SECURITY_METHODS,
                requiredMethodCount: 1,
            },
        });

        await tx.twoFactorBackupCode.deleteMany({
            where: { userId: user.id },
        });

        await tx.twoFactorBackupCode.createMany({
            data: hashedBackupCodes.map((codeHash) => ({
                userId: user.id,
                codeHash,
                createdAt: new Date(),
            })),
        });
    });

    console.log(`  ✓ 2FA test user configured: ${TEST_EMAIL}`);
    console.log(`    TOTP secret : ${KNOWN_TOTP_SECRET}`);
    console.log(`    Backup codes: ${KNOWN_BACKUP_CODES.join(", ")}`);
    console.log(`    Email OTPs  : http://localhost:8025 (Mailhog)`);
}

main()
    .catch((err) => {
        console.error("Fatal:", err);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
