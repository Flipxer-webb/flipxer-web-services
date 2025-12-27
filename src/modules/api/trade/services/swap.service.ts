import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import { buildResponse } from "@/utils/api-response-util";
import { User } from "@prisma/client";
import { IncompleteAccountSetupException } from "../errors";
import {
    PlaceInstantSwapRequestDto,
    RefreshInstantSwapRequestDto,
    ConfirmInstantSwapQuoteDto,
} from "../dtos";
import { QUOTE_EXPIRY_MS } from "../constants";

/**
 * Swap Service
 * 
 * Handles all crypto-to-crypto swap operations including:
 * - Creating instant swap quotes
 * - Refreshing swap quotes
 * - Confirming swap transactions
 */
@Injectable()
export class SwapService {
    private readonly logger = new Logger("SwapService");

    constructor(
        private readonly prisma: PrismaService,
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService
    ) { }

    /**
     * Creates an instant swap quote request
     */
    async createInstantSwap(user: User, dto: PlaceInstantSwapRequestDto) {
        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "Please complete your account setup or contact admin for support",
                HttpStatus.BAD_REQUEST
            );
        }

        const swapInfo = await this.quidaxService.createInstantSwapRequest(
            user.cryptoSubAccountId,
            {
                from_currency: dto.from_currency,
                to_currency: dto.to_currency,
                ...(dto.from_amount && {
                    from_amount: dto.from_amount.toString(),
                }),
                ...(dto.to_amount && { to_amount: dto.to_amount?.toString() }),
            }
        );

        // Extend quote expiration time for better UX with 2FA
        const extendedExpiresAt = new Date(Date.now() + QUOTE_EXPIRY_MS).toISOString();

        return buildResponse({
            message: "Swap request quote retrieved successfully",
            data: {
                ...swapInfo.data,
                expires_at: extendedExpiresAt,
            },
        });
    }

    /**
     * Refreshes an existing swap quote
     */
    async refreshInstantSwap(user: User, dto: RefreshInstantSwapRequestDto) {
        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "Please complete your account setup or contact admin for support",
                HttpStatus.BAD_REQUEST
            );
        }

        const swapInfo = await this.quidaxService.refreshInstantSwapQuote(
            user.cryptoSubAccountId,
            dto.quotation_id,
            {
                from_currency: dto.from_currency,
                to_currency: dto.to_currency,
                ...(dto.from_amount && {
                    from_amount: dto.from_amount.toString(),
                }),
                ...(dto.to_amount && { to_amount: dto.to_amount?.toString() }),
            }
        );

        // Extend quote expiration time for better UX with 2FA
        const extendedExpiresAt = new Date(Date.now() + QUOTE_EXPIRY_MS).toISOString();

        return buildResponse({
            message: "Swap request quote retrieved successfully",
            data: {
                ...swapInfo.data,
                expires_at: extendedExpiresAt,
            },
        });
    }

    /**
     * Confirms and executes a swap quote.
     * 
     * If the quote has expired (Quidax 15s limit), this method will:
     * 1. Get a completely fresh quote (not refresh - which also fails if expired)
     * 2. Immediately confirm the new quote
     * 
     * @throws TransactionExpiredException if quote expired and no refresh params provided
     */
    async confirmInstantSwapQuote(user: User, dto: ConfirmInstantSwapQuoteDto) {
        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "Please complete your account setup or contact admin for support",
                HttpStatus.BAD_REQUEST
            );
        }

        try {
            // Attempt to confirm the swap
            const swapInfo = await this.quidaxService.confirmInstantSwap({
                user_id: user.cryptoSubAccountId,
                quotation_id: dto.quotationId,
            });

            return buildResponse({
                message: "Swap confirmed successfully",
                data: swapInfo.data,
            });
        } catch (error: any) {
            // Check if this is a quote expired error
            const errorMessage = (error?.message || error?.response?.data?.message || "").toLowerCase();
            const isExpiredError = errorMessage.includes("expired") ||
                errorMessage.includes("invalid quotation") ||
                errorMessage.includes("quotation not found");

            // If expired and we have required params, get a FRESH quote and confirm
            if (isExpiredError && dto.from_currency && dto.to_currency && dto.from_amount) {
                this.logger.log(`Quote ${dto.quotationId} expired, getting fresh quote...`);

                // Get a completely NEW quote (not refresh - which also fails with expired quote)
                const freshQuote = await this.quidaxService.createInstantSwapRequest(
                    user.cryptoSubAccountId,
                    {
                        from_currency: dto.from_currency,
                        to_currency: dto.to_currency,
                        from_amount: dto.from_amount.toString(),
                    }
                );

                this.logger.log(`Got fresh quote ${freshQuote.data.id}, confirming immediately...`);

                // Immediately confirm the new quote
                const retrySwapInfo = await this.quidaxService.confirmInstantSwap({
                    user_id: user.cryptoSubAccountId,
                    quotation_id: freshQuote.data.id,
                });

                return buildResponse({
                    message: "Swap confirmed successfully",
                    data: retrySwapInfo.data,
                });
            }

            // Re-throw if we can't auto-refresh
            throw error;
        }
    }

    /**
     * Executes an atomic swap operation.
     * 
     * This is the recommended method for swaps as it:
     * 1. Gets a fresh quote from Quidax
     * 2. Immediately confirms it (within milliseconds)
     * 3. Returns the completed swap result
     * 
     * This eliminates all timing issues with quote expiry since the quote
     * never has time to expire between creation and confirmation.
     */
    async executeAtomicSwap(user: User, dto: {
        from_currency: string;
        to_currency: string;
        from_amount: number;
    }) {
        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "Please complete your account setup or contact admin for support",
                HttpStatus.BAD_REQUEST
            );
        }

        this.logger.log(`Executing atomic swap: ${dto.from_amount} ${dto.from_currency} -> ${dto.to_currency}`);

        // Step 1: Get a fresh quote
        const quoteStartTime = Date.now();
        const quote = await this.quidaxService.createInstantSwapRequest(
            user.cryptoSubAccountId,
            {
                from_currency: dto.from_currency.toLowerCase(),
                to_currency: dto.to_currency.toLowerCase(),
                from_amount: dto.from_amount.toString(),
            }
        );
        this.logger.log(`Got quote ${quote.data.id} in ${Date.now() - quoteStartTime}ms`);

        // Step 2: Immediately confirm the quote
        const confirmStartTime = Date.now();
        const swapResult = await this.quidaxService.confirmInstantSwap({
            user_id: user.cryptoSubAccountId,
            quotation_id: quote.data.id,
        });
        this.logger.log(`Confirmed swap in ${Date.now() - confirmStartTime}ms`);

        this.logger.log(`Atomic swap completed: ${dto.from_amount} ${dto.from_currency} -> ${swapResult.data.to_amount} ${dto.to_currency}`);

        return buildResponse({
            message: "Swap executed successfully",
            data: {
                ...swapResult.data,
                quote: quote.data, // Include quote details for reference
            },
        });
    }
}
