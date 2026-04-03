export const TOKEN_EXPIRATION = "4h";
export const REFRESH_TOKEN_EXPIRATION = "1d"; // Must be longer than access token expiry
export const DB_TRANSACTION_TIMEOUT = 10000;
export const COMPANY_NAME = "Flipxer";
export const BCRYPT_SALT = 10;
export const IDENTITY_DEDUP_ENABLED = process.env.IDENTITY_DEDUP_ENABLED !== "false";
