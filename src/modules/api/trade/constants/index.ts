import { NetworkTypes } from "@prisma/client";

/**
 * Trade Module Constants
 * Centralized configuration for all trading-related constants
 */

// ==================== NETWORK CONFIGURATION ====================

/**
 * Maps various network name formats to standardized NetworkTypes enum values.
 * Used to normalize network names from different sources (user input, Quidax API, etc.)
 */
export const NETWORK_ALIAS_MAP: Record<string, NetworkTypes> = {
    // TRC20 / Tron
    trc20: NetworkTypes.trc20,
    tron: NetworkTypes.trc20,

    // ERC20 / Ethereum
    erc20: NetworkTypes.erc20,
    ethereum: NetworkTypes.erc20,
    eth: NetworkTypes.erc20,

    // BEP20 / BSC
    bep20: NetworkTypes.bep20,
    bsc: NetworkTypes.bep20,
    bnb: NetworkTypes.bep20,

    // Bitcoin
    btc: NetworkTypes.btc,
    bitcoin: NetworkTypes.btc,

    // Litecoin
    ltc: NetworkTypes.ltc,
    litecoin: NetworkTypes.ltc,

    // Other networks
    dash: NetworkTypes.dash,
    doge: NetworkTypes.doge,
    dogecoin: NetworkTypes.doge,
    bch: NetworkTypes.bch,
    "bitcoin cash": NetworkTypes.bch,

    // XRP / Ripple
    ripple: NetworkTypes.ripple,
    xrp: NetworkTypes.ripple,

    // Stellar
    stellar: NetworkTypes.stellar,
    xlm: NetworkTypes.stellar,

    // Cardano
    cardano: NetworkTypes.cardano,
    ada: NetworkTypes.cardano,

    // Solana
    solana: NetworkTypes.solana,
    sol: NetworkTypes.solana,

    // Polygon
    polygon: NetworkTypes.polygon,
    matic: NetworkTypes.polygon,

    // Other L2s and chains
    ton: NetworkTypes.ton,
    celo: NetworkTypes.celo,
    optimism: NetworkTypes.optimism,
    arbitrum: NetworkTypes.arbitrum,
    base: NetworkTypes.base,
};

/**
 * Regex pattern for splitting network identifiers
 * Handles formats like: "tron_trc20", "ethereum-erc20", "bitcoin/btc"
 */
export const NETWORK_SEGMENT_SPLITTER = /[\s/_-]+/;

// ==================== SUPPORTED ASSETS ====================

/**
 * Set of cryptocurrency symbols supported by the platform with full Quidax wallet support.
 * Used for validation and wallet creation filtering.
 */
export const SUPPORTED_ASSETS = new Set([
    "BTC",   // Bitcoin
    "ETH",   // Ethereum
    "USDT",  // Tether
    "USDC",  // USD Coin
    "BNB",   // Binance Coin
    "SOL",   // Solana
    "XRP",   // Ripple
    "ADA",   // Cardano
    "DOGE",  // Dogecoin
    "LTC",   // Litecoin
    "TRX",   // Tron
    "SHIB",  // Shiba Inu
]);

/**
 * Array version of supported currencies for iteration (lowercase for Quidax API)
 */
export const SUPPORTED_CURRENCIES = [
    "btc",
    "eth",
    "usdt",
    "usdc",
    "bnb",
    "sol",
    "xrp",
    "ada",
    "doge",
    "ltc",
    "trx",
    "shib",
] as const;

/**
 * All supported currencies for deposit sync (includes additional assets)
 */
export const ALL_SUPPORTED_CURRENCIES_FOR_SYNC = [
    "usdt",
    "btc",
    "eth",
    "usdc",
    "sol",
    "xrp",
    "bnb",
    "trx",
    "matic",
    "avax",
] as const;

// ==================== TIMING CONSTANTS ====================

/**
 * Quote expiration time in milliseconds (displayed to user).
 * 
 * IMPORTANT: Quidax quotes are only valid for 15 seconds on their end.
 * We match this timing exactly. If quote expires, request a fresh quote.
 * 
 * @see https://docs.quidax.com - Instant Swap documentation
 */
export const QUOTE_EXPIRY_MS = 25 * 1000;

/**
 * When to trigger auto-refresh before quote expires (in ms).
 * Refresh 3 seconds before displayed expiry to ensure fresh quote.
 */
export const QUOTE_REFRESH_THRESHOLD_MS = 12 * 1000;

/**
 * Wallet cache TTL in seconds (respects Quidax rate limits)
 */
export const WALLET_CACHE_TTL_SECONDS = 45;

/**
 * Default transaction timeout in milliseconds for Prisma transactions
 */
export const DEFAULT_TRANSACTION_TIMEOUT_MS = 20000;

/**
 * Extended transaction timeout for complex operations
 */
export const EXTENDED_TRANSACTION_TIMEOUT_MS = 40000;

/**
 * Maximum wait time before acquiring transaction lock
 */
export const DEFAULT_TRANSACTION_MAX_WAIT_MS = 5000;

// ==================== TIER & LIMITS ====================

/**
 * Daily withdrawal limits in USD per tier
 * 
 * IMPORTANT: These MUST match the WITHDRAWAL_LIMITS in tier.service.ts
 * Tier structure:
 *   0 = Basic (deposit only)
 *   1 = Standard (BVN/NIN verified)
 *   2 = Intermediate (Document verified)
 *   3 = Pro (Address verified)
 *   4 = Premium (Income verified)
 */
export const TIER_DAILY_LIMITS: Record<number, number | "unlimited"> = {
    0: 0,              // Tier 0: Cannot transact
    1: 10000,          // Tier 1: $10,000/day
    2: 50000,          // Tier 2: $50,000/day
    3: 100000,         // Tier 3: $100,000/day
    4: "unlimited",    // Tier 4: Unlimited
};

/**
 * Monthly withdrawal limits in USD per tier
 * Note: Monthly limits are 10x daily limits (approximate)
 */
export const TIER_MONTHLY_LIMITS: Record<number, number | "unlimited"> = {
    0: 0,
    1: 300000,         // $300,000/month
    2: 1500000,        // $1,500,000/month
    3: 3000000,        // $3,000,000/month
    4: "unlimited",
};

// ==================== BATCH SIZES ====================

/**
 * Batch size for processing wallet creation
 */
export const WALLET_CREATION_BATCH_SIZE = 100;

/**
 * Maximum notifications to fetch for list
 */
export const MAX_NOTIFICATIONS_FETCH = 20;

// ==================== REFERENCE CURRENCY ====================

/**
 * Default fiat reference currency
 */
export const DEFAULT_FIAT_CURRENCY = "NGN";

/**
 * Default fiat currency for API responses
 */
export const QUOTE_RESPONSE_CURRENCY = "NGN";
