import { BadRequestException, Injectable } from "@nestjs/common";
import { NetworkTypes } from "@prisma/client";
import {
    NETWORK_ALIAS_MAP,
    NETWORK_SEGMENT_SPLITTER,
} from "../constants";

/**
 * Trade Helpers Service
 * 
 * Provides utility methods for trading operations including:
 * - Network name normalization
 * - Input validation helpers
 * - Common conversion utilities
 */
@Injectable()
export class TradeHelpersService {
    /**
     * Set of all supported network types from Prisma enum
     */
    private readonly supportedNetworkSet = new Set<string>(
        Object.values(NetworkTypes)
    );

    /**
     * Normalizes various network name formats to standardized NetworkTypes enum values.
     * 
     * Handles cases like:
     * - Direct matches: "trc20" → NetworkTypes.trc20
     * - Aliases: "tron" → NetworkTypes.trc20
     * - Compound formats: "tron_trc20" → NetworkTypes.trc20
     * - Case insensitive: "TRC20", "Trc20" → NetworkTypes.trc20
     * 
     * @param network - Raw network string from user input or API
     * @returns Normalized NetworkTypes enum value, or null if not recognized
     * 
     * @example
     * normalizeNetworkInput("trc20")       // → NetworkTypes.trc20
     * normalizeNetworkInput("tron_trc20")  // → NetworkTypes.trc20
     * normalizeNetworkInput("ETHEREUM")    // → NetworkTypes.erc20
     * normalizeNetworkInput(null)          // → null
     * normalizeNetworkInput("unknown")     // → null
     */
    normalizeNetworkInput(network?: string | null): NetworkTypes | null {
        if (!network) {
            return null;
        }

        const trimmed = network.trim().toLowerCase();

        if (!trimmed) {
            return null;
        }

        // Try direct match first (most common case)
        const directMatch =
            NETWORK_ALIAS_MAP[trimmed] ||
            (this.supportedNetworkSet.has(trimmed)
                ? (trimmed as NetworkTypes)
                : null);

        if (directMatch) {
            return directMatch;
        }

        // Handle compound formats like "tron_trc20" or "ethereum/erc20"
        // Try segments in reverse order (last segment often most specific)
        const segments = trimmed.split(NETWORK_SEGMENT_SPLITTER).reverse();

        for (const segment of segments) {
            if (!segment) {
                continue;
            }

            const alias =
                NETWORK_ALIAS_MAP[segment] ||
                (this.supportedNetworkSet.has(segment)
                    ? (segment as NetworkTypes)
                    : null);

            if (alias) {
                return alias;
            }
        }

        return null;
    }

    /**
     * Validates if a given network string is supported.
     * 
     * @param network - The network string to validate
     * @returns True if the network is recognized and supported
     */
    isNetworkSupported(network: string): boolean {
        return this.normalizeNetworkInput(network) !== null;
    }

    /**
     * Gets the network display name from a NetworkTypes enum value.
     * 
     * @param network - The NetworkTypes enum value
     * @returns Human-readable network name
     */
    getNetworkDisplayName(network: NetworkTypes): string {
        const displayNames: Record<NetworkTypes, string> = {
            [NetworkTypes.trc20]: "Tron (TRC-20)",
            [NetworkTypes.erc20]: "Ethereum (ERC-20)",
            [NetworkTypes.bep20]: "BNB Smart Chain (BEP-20)",
            [NetworkTypes.btc]: "Bitcoin",
            [NetworkTypes.ltc]: "Litecoin",
            [NetworkTypes.dash]: "Dash",
            [NetworkTypes.doge]: "Dogecoin",
            [NetworkTypes.bch]: "Bitcoin Cash",
            [NetworkTypes.ripple]: "Ripple (XRP)",
            [NetworkTypes.stellar]: "Stellar (XLM)",
            [NetworkTypes.cardano]: "Cardano (ADA)",
            [NetworkTypes.solana]: "Solana",
            [NetworkTypes.polygon]: "Polygon",
            [NetworkTypes.ton]: "TON",
            [NetworkTypes.celo]: "Celo",
            [NetworkTypes.optimism]: "Optimism",
            [NetworkTypes.arbitrum]: "Arbitrum",
            [NetworkTypes.base]: "Base",
        };

        return displayNames[network] || network;
    }

    /**
     * Parses and validates a cryptocurrency amount string.
     * 
     * @param amount - The amount string to parse
     * @param minAmount - Optional minimum allowed amount
     * @returns Parsed number or null if invalid
     */
    parseAmount(amount: string | number, minAmount?: number): number | null {
        const parsed = typeof amount === "number" ? amount : Number.parseFloat(amount);
        
        if (Number.isNaN(parsed) || !Number.isFinite(parsed) || parsed < 0) {
            return null;
        }

        if (minAmount !== undefined && parsed < minAmount) {
            return null;
        }

        return parsed;
    }

    /**
     * Formats a cryptocurrency amount with appropriate decimal places.
     * 
     * @param amount - The amount to format
     * @param decimals - Number of decimal places (default: 8)
     * @returns Formatted amount string
     */
    formatAmount(amount: number, decimals: number = 8): string {
        const str = amount.toFixed(decimals);
        let end = str.length - 1;
        while (end > 0 && str[end] === '0') end--;
        if (str[end] === '.') end--;
        return str.substring(0, end + 1);
    }

    /**
     * Formats a fiat currency amount.
     * 
     * @param amount - The amount to format
     * @param currency - Currency code (default: "NGN")
     * @returns Formatted currency string
     */
    formatFiatAmount(amount: number, currency: string = "NGN"): string {
        return new Intl.NumberFormat("en-NG", {
            style: "currency",
            currency: currency,
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        }).format(amount);
    }

    /**
     * Safely stringifies an object for logging, handling BigInt values.
     * 
     * @param data - Object to stringify
     * @returns JSON string with BigInt values converted to strings
     */
    safeJsonStringify(data: Record<string, unknown>): string {
        return JSON.stringify(data, (_, value) =>
            typeof value === "bigint" ? value.toString() : value
        );
    }

    validateMinimumAmountInUSDT(
        amount: number,
        asset: string,
        minimumAmountInUsdt: number,
        tradeType: "buy" | "sell"
    ): void {
        if (!Number.isFinite(minimumAmountInUsdt) || minimumAmountInUsdt <= 0) {
            return;
        }

        if (!Number.isFinite(amount) || amount <= 0) {
            throw new BadRequestException(`Invalid ${tradeType} amount for ${asset}`);
        }

        if (amount < minimumAmountInUsdt) {
            throw new BadRequestException(
                `Minimum ${tradeType} amount for ${asset.toUpperCase()} is ${minimumAmountInUsdt}`
            );
        }
    }
}
