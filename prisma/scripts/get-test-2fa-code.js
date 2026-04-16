/**
 * Generate the current TOTP code for the 2FA test user.
 *
 * Usage (from flipxer-web-services/ root):
 *   node prisma/scripts/get-test-2fa-code.js
 *
 * The code rotates every 30 seconds. Copy it immediately after running.
 * Use it on the 2FA verification screen when logged in as:
 *   twofactor.test@flipxer.local / TwoFactor@2024!
 */

// Uses the same library already available in the project
const speakeasy = require("speakeasy");

const KNOWN_TOTP_SECRET = "JBSWY3DPEHPK3PXP";

const token = speakeasy.totp({
    secret: KNOWN_TOTP_SECRET,
    encoding: "base32",
});

const remaining = 30 - (Math.floor(Date.now() / 1000) % 30);

console.log("─────────────────────────────────────");
console.log("  2FA Test User — TOTP Code");
console.log("─────────────────────────────────────");
console.log(`  User   : twofactor.test@flipxer.local`);
console.log(`  Code   : ${token}`);
console.log(`  Expires: ~${remaining}s`);
console.log("─────────────────────────────────────");
console.log("  Backup codes (reset each docker-up):");
const BACKUP_CODES = [
    "ABCDE-FGHJK-LMNPQ-RSTUV",
    "WXY23-45678-9ABCD-EFGHJ",
    "KLMNP-QRSTV-WXY23-45678",
    "9ABCD-EFGHJ-KLMNP-QRSTV",
    "TRADX-SAFE2-GUARD-KEY45",
];
BACKUP_CODES.forEach((c, i) => console.log(`  ${i + 1}.  ${c}`));
console.log("─────────────────────────────────────");
console.log("  Email OTPs → http://localhost:8025 (Mailhog)");
console.log("─────────────────────────────────────");
