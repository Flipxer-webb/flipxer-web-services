/**
 * Seed file constants
 * Character set used for generating random passwords during database seeding.
 * This is NOT a hardcoded password - it defines which characters can be used
 * when generating new random passwords.
 */

// Alphanumeric characters excluding confusing ones (0, O, I, l) plus special chars
export const SEED_PASSWORD_CHARSET =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789!@#$%^&*";

export const SEED_PASSWORD_LENGTH = 16;
