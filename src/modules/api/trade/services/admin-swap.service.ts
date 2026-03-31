import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { buildResponse } from "@/utils/api-response-util";
import { AdminSwapQuoteDto, AdminSwapConfirmDto } from "../dtos";
import { PrismaService } from "@/modules/core/prisma/services";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { GeneralTransactionException } from "../errors";
import { OrderCategory, OrderStatus } from "@prisma/client";
import { getStreamlinedStatus } from "../interfaces/trade";

@Injectable()
export class AdminSwapService {
    private readonly logger = new Logger(AdminSwapService.name);

    constructor(
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService,
        private readonly prisma: PrismaService,
        private readonly slackWebhookService: SlackWebhookService,
    ) {}

    async getSwapQuote(dto: AdminSwapQuoteDto) {
        this.logger.log(
            `Admin swap quote: ${dto.from_amount} ${dto.from_currency} -> ${dto.to_currency}`,
        );

        const result = await this.quidaxService.createInstantSwapRequest(
            "me",
            {
                from_currency: dto.from_currency.toLowerCase(),
                to_currency: dto.to_currency.toLowerCase(),
                from_amount: dto.from_amount.toString(),
            },
        );

        return buildResponse({
            message: "Admin swap quote retrieved",
            data: {
                quotation_id: result.data.id,
                from_currency: result.data.from_currency,
                to_currency: result.data.to_currency,
                from_amount: result.data.from_amount,
                to_amount: result.data.to_amount,
                rate: result.data.quoted_price,
                expires_at: result.data.expires_at,
            },
        });
    }

    async confirmSwap(dto: AdminSwapConfirmDto, adminUserId: number) {
        this.logger.log(
            `Admin confirming swap quote ${dto.quotation_id} (admin: ${adminUserId})`,
        );

        // Idempotency: reject if this quotation was already confirmed
        const existing = await this.prisma.order.findFirst({
            where: { quotationId: dto.quotation_id },
        });
        if (existing) {
            throw new GeneralTransactionException(
                "This swap quote has already been confirmed",
                HttpStatus.CONFLICT,
            );
        }

        const result = await this.quidaxService.confirmInstantSwap({
            user_id: "me",
            quotation_id: dto.quotation_id,
        });

        const swap = result.data;

        // Log the admin swap in the database for audit
        await this.prisma.order.create({
            data: {
                orderCategory: OrderCategory.SWAP,
                status: swap.status === "completed" ? OrderStatus.completed : OrderStatus.processing,
                streamlinedStatus: getStreamlinedStatus(swap.status === "completed" ? "completed" : "processing"),
                orderReference: `admin-swap-${dto.quotation_id}`,
                transactionId: `admin-swap-${swap.id}`,
                userId: adminUserId,
                fromCurrency: swap.from_currency.toUpperCase(),
                toCurrency: swap.to_currency.toUpperCase(),
                fromAmount: Number.parseFloat(swap.from_amount),
                toAmount: Number.parseFloat(swap.received_amount),
                quoted_price: Number.parseFloat(swap.execution_price),
                currency: swap.from_currency.toUpperCase(),
                amount: Number.parseFloat(swap.from_amount),
                rateAtConversion: Number.parseFloat(swap.execution_price),
                total: Number.parseFloat(swap.from_amount),
                recipient: "Platform Main Wallet",
                narration: `Admin Swap by #${adminUserId}: ${swap.from_currency.toUpperCase()} -> ${swap.to_currency.toUpperCase()}`,
                transaction_note: `Admin rebalance: ${swap.from_amount} ${swap.from_currency} -> ${swap.received_amount} ${swap.to_currency}`,
                fee: 0,
                quotationId: dto.quotation_id,
            },
        });

        // Notify via Slack
        this.slackWebhookService
            .sendAlert("ADMIN_SWAP_EXECUTED", {
                text:
                    `💱 Admin Swap Executed\n` +
                    `Admin User: ${adminUserId}\n` +
                    `From: ${swap.from_amount} ${swap.from_currency.toUpperCase()}\n` +
                    `To: ${swap.received_amount} ${swap.to_currency.toUpperCase()}\n` +
                    `Rate: ${swap.execution_price}\n` +
                    `Status: ${swap.status}`,
            })
            .catch((err) =>
                this.logger.warn(`Failed to send admin swap Slack alert: ${err.message}`),
            );

        return buildResponse({
            message: "Admin swap confirmed",
            data: {
                id: swap.id,
                from_currency: swap.from_currency,
                to_currency: swap.to_currency,
                from_amount: swap.from_amount,
                received_amount: swap.received_amount,
                execution_price: swap.execution_price,
                status: swap.status,
                created_at: swap.created_at,
            },
        });
    }
}
