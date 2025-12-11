import * as QD from "@/libs/quidax";
import { Logger } from "@nestjs/common";
import * as t from "../types";
import { executeQuidaxCall } from "./error-handler";

/**
 * Quidax Purchase Service - Handles purchase limits, quotes, and payment methods
 */
export class QuidaxPurchaseService {
    private readonly logger = new Logger(QuidaxPurchaseService.name);
    constructor(private readonly quidax: QD.QuidaxLib) {}

    async getPaymentMethods(
        options: t.PaymentMethodsOptions
    ): Promise<QD.QuidaxResponse<any>> {
        return executeQuidaxCall(
            () => this.quidax.getPaymentMethods(options),
            "get payment methods",
            this.logger
        );
    }

    async getPurchaseLimitForBuy(
        options: t.PurchaseLimitBuyOptions
    ): Promise<QD.QuidaxResponse<any>> {
        return executeQuidaxCall(
            () => this.quidax.getPurchaseLimitForBuy(options),
            "get purchase limit",
            this.logger
        );
    }

    async getPurchaseLimitForSell(
        options: t.PurchaseLimitSellOptions
    ): Promise<QD.QuidaxResponse<any>> {
        return executeQuidaxCall(
            () => this.quidax.getPurchaseLimitForSell(options),
            "get purchase limit",
            this.logger
        );
    }

    async getPurchaseQuoteForBuy(
        options: t.PurchaseQuoteBuyOptions
    ): Promise<QD.QuidaxResponse<any>> {
        return executeQuidaxCall(
            () => this.quidax.getPurchaseQuoteForBuy(options),
            "get purchase quote",
            this.logger
        );
    }

    async getPurchaseQuoteForSell(
        options: t.PurchaseQuoteSellOptions
    ): Promise<QD.QuidaxResponse<any>> {
        return executeQuidaxCall(
            () => this.quidax.getPurchaseQuoteForSell(options),
            "get purchase quote",
            this.logger
        );
    }
}
