import { CanActivate, ExecutionContext, HttpStatus, Injectable } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { Inject } from "@nestjs/common";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import { RequestWithUser } from "../../auth/interfaces";
import { User } from "@prisma/client";
import {
    GeneralTransactionException,
    InvalidTransactionAmountException,
} from "@/modules/api/trade/errors";
import { UserNotFoundException } from "@/modules/api/user";

@Injectable()
export class TransactionAmountGuard implements CanActivate {
    constructor(
        private readonly prisma: PrismaService,
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<RequestWithUser>();
        const user: User = request.user;
        const body = request.body;

        if (!user) {
            throw new UserNotFoundException(
                "User not found in request",
                HttpStatus.UNAUTHORIZED
            );
        }

        let amount: number | undefined;
        let currency: string | undefined;

        // Extract amount and currency based on endpoint
        const path = request.path;

        if (path.includes("buy/order") || path.includes("buy/quote")) {
            amount = body.amount;
            currency = body.asset?.toUpperCase();
        } else if (path.includes("sell/order") || path.includes("sell/quote")) {
            amount = body.amount;
            currency = body.asset?.toUpperCase();
        } else if (path.includes("request-instant-swap-quote") || path.includes("refresh-instant-swap-quote")) {
            amount = body.from_amount || body.to_amount;
            currency = body.from_amount ? body.from_currency?.toUpperCase() : body.to_currency?.toUpperCase();
        } else if (path.includes("confirm-instant-swap-quote")) {
            if (!body.quotationId) {
                throw new InvalidTransactionAmountException(
                    "Quotation ID is required for swap confirmation",
                    HttpStatus.BAD_REQUEST
                );
            }
            const swapInfo = await this.quidaxService.getSwapTransaction({
                swap_transaction_id: body.quotationId,
                user_id: user.cryptoSubAccountId,
            });
            amount = Number(swapInfo.data?.from_amount) || Number(swapInfo.data?.received_amount);
            currency = swapInfo.data?.from_currency?.toUpperCase() || swapInfo.data?.to_currency?.toUpperCase();
        } else if (path.includes("withdrawer-request")) {
            amount = body.amount;
            currency = body.currency?.toUpperCase();
        }

        if (!amount || !currency) {
            throw new InvalidTransactionAmountException(
                `Missing amount or currency in request at ${path}`,
                HttpStatus.BAD_REQUEST
            );
        }

        // Convert amount to USD
        const amountInUSD = await this.getAmountInUSD(currency, amount);

        if (!amountInUSD || !amountInUSD.amount) {
            throw new GeneralTransactionException(
                `Failed to convert ${amount} ${currency} to USD`,
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }

        // Define thresholds based on userType
        const threshold = user.userType === "INDIVIDUAL" ? 10000 : 20000;

        // Check if amount exceeds threshold
        if (amountInUSD.amount > threshold) {
            await this.prisma.$transaction(async (tx) => {
                const flaggedRecord = await tx.flagged.upsert({
                    where: { userId: user.id },
                    create: {
                        userId: user.id,
                        flagged: true,
                        reason: `Transaction amount exceeds $${threshold} threshold for ${user.userType} user (Amount: ${amount} ${currency} = $${amountInUSD.amount.toFixed(2)})`,
                        updatedAt: new Date(),
                    },
                    update: {
                        flagged: true,
                        reason: `Transaction amount exceeds $${threshold} threshold for ${user.userType} user (Amount: ${amount} ${currency} = $${amountInUSD.amount.toFixed(2)})`,
                        updatedAt: new Date(),
                    },
                });

                await tx.user.update({
                    where: { id: user.id },
                    data: { flaggedId: flaggedRecord.id },
                });
            });
        }

        return true; // Allow request to proceed after flagging
    }

    async getAmountInUSD(
        asset: string,
        amount: number
    ): Promise<{ amount?: number; rate?: number } | null> {
        const referenceCurrency = "usd";
        const assetCurrency = asset.toLowerCase();
        const marketSymbol = `${assetCurrency}${referenceCurrency}`;

        try {
            const marketData = await this.quidaxService.getSingleMarketTicker(marketSymbol);
            const ticker = marketData.data?.ticker;
            if (!ticker) {
                throw new GeneralTransactionException(
                    `No ticker data available for ${marketSymbol}`,
                    HttpStatus.INTERNAL_SERVER_ERROR
                );
            }

            const rate = parseFloat(ticker.last);
            if (isNaN(rate)) {
                throw new GeneralTransactionException(
                    `Invalid USD rate for ${asset}`,
                    HttpStatus.INTERNAL_SERVER_ERROR
                );
            }

            return {
                amount: amount * rate,
                rate: rate,
            };
        } catch (error) {
            throw new GeneralTransactionException(
                `Failed to fetch USD rate for ${asset}: ${error.message}`,
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }
}