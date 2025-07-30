import {
    CanActivate,
    ExecutionContext,
    HttpStatus,
    Injectable,
    Logger,
} from "@nestjs/common";
import { PrismaService } from "../../../core/prisma/services";
import { Inject } from "@nestjs/common";
import { User } from "@prisma/client";
import { RequestWithUser } from "../../auth/interfaces";
import {
    GeneralTransactionException,
    InvalidTransactionAmountException,
} from "../../../api/trade/errors";
import { UserNotFoundException } from "../../../api/user";
import axios from "axios";

// Injection token for CoinGeckoService
export const TradingInjectionToken = {
    COINGECKO: Symbol("COINGECKO"),
};

@Injectable()
export class CoinGeckoService {
    private readonly logger = new Logger(CoinGeckoService.name);

    async getPriceInUSD(asset: string): Promise<number> {
        const coinGeckoIdMap: { [key: string]: string } = {
            btc: "bitcoin",
            eth: "ethereum",
            usdt: "tether",
            bnb: "binancecoin",
        };
        const coinGeckoId = coinGeckoIdMap[asset.toLowerCase()] || asset.toLowerCase();

        this.logger.log(`Fetching USD price for asset: ${asset} (ID: ${coinGeckoId})`);

        try {
            const response = await axios.get("https://api.coingecko.com/api/v3/simple/price", {
                params: {
                    ids: coinGeckoId,
                    vs_currencies: "usd",
                },
            });

            const rate = response.data[coinGeckoId]?.usd;
            if (!rate) throw new Error(`No price data for ${asset}`);
            return rate;
        } catch (error) {
            this.logger.error(`CoinGecko error: ${error.message}`);
            throw new GeneralTransactionException(
                `Failed to fetch USD rate for ${asset}: ${error.message}`,
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }
}

@Injectable()
export class TransactionAmountGuard implements CanActivate {

    constructor(
        private readonly prisma: PrismaService,
        @Inject(TradingInjectionToken.COINGECKO)
        private readonly coinGeckoService: CoinGeckoService
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<RequestWithUser>();
        const user: User = request.user;
        const body = request.body;
        const path = request.path;

        if (!user) {
            throw new UserNotFoundException("User not found", HttpStatus.UNAUTHORIZED);
        };

        const flagged = await this.prisma.flagged.findUnique({
            where: { userId: user.id },
          });
      
          if (flagged?.flagged) {
            throw new GeneralTransactionException(
              `Transaction blocked: user is already flagged.`,
              HttpStatus.FORBIDDEN
            );
          }

        let amount: number | undefined;
        let currency: string | undefined;

        if (path.includes("buy/order") || path.includes("buy/quote")) {
            amount = body.amount;
            currency = body.asset?.toUpperCase();
        } else if (path.includes("sell/order") || path.includes("sell/quote")) {
            amount = body.amount;
            currency = body.asset?.toUpperCase();
        } else if (path.includes("request-instant-swap-quote") || path.includes("refresh-instant-swap-quote")) {
            amount = body.from_amount || body.to_amount;
            currency = body.from_amount ? body.from_currency?.toUpperCase() : body.to_currency?.toUpperCase();
        } else if (path.includes("withdrawer-request")) {
            amount = body.amount;
            currency = body.currency?.toUpperCase();
        }

        if (!amount || !currency) {
            throw new InvalidTransactionAmountException(
                `Missing amount or currency at ${path}`,
                HttpStatus.BAD_REQUEST
            );
        }

        const amountInUSD = await this.getAmountInUSD(currency, amount);

        if (!amountInUSD || !amountInUSD.amount) {
            throw new GeneralTransactionException(
                `Conversion failed for ${amount} ${currency}`,
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }

        const threshold = user.userType === "INDIVIDUAL" ? 10000 : 20000;

        if (amountInUSD.amount > threshold) {
            const flaggedRecord = await this.prisma.$transaction(async (tx) => {
                const record = await tx.flagged.upsert({
                    where: { userId: user.id },
                    create: {
                        userId: user.id,
                        flagged: true,
                        reason: `Amount exceeds $${threshold} for ${user.userType} ($${amountInUSD.amount})`,
                        updatedAt: new Date(),
                    },
                    update: {
                        flagged: true,
                        reason: `Amount exceeds $${threshold} for ${user.userType} ($${amountInUSD.amount})`,
                        updatedAt: new Date(),
                    },
                });

                await tx.user.update({
                    where: { id: user.id },
                    data: { flaggedId: record.id },
                });

                return record;
            });

            throw new GeneralTransactionException(
                `Transaction exceeds threshold. User flagged. Flag ID: ${flaggedRecord.id}`,
                HttpStatus.FORBIDDEN
            );
        }

        return true;
    }

    async getAmountInUSD(asset: string, amount: number): Promise<{ amount?: number; rate?: number } | null> {
        const rate = await this.coinGeckoService.getPriceInUSD(asset);
        return {
            amount: amount * rate,
            rate,
        };
    }
}
