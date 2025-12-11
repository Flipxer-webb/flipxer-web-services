import * as QD from "@/libs/quidax";
import { Logger } from "@nestjs/common";
import * as t from "../types";
import { executeQuidaxCall } from "./error-handler";

/**
 * Quidax Order Service - Handles buy/sell orders
 */
export class QuidaxOrderService {
    private readonly logger = new Logger(QuidaxOrderService.name);
    constructor(private readonly quidax: QD.QuidaxLib) {}

    async buyOrSellOrderRequest(
        user_id: string,
        options: t.SellOrBuyOrderRequestOptions
    ): Promise<QD.QuidaxResponse<QD.SellOrBuyOrderRequestResponse>> {
        return executeQuidaxCall(
            () => this.quidax.buyOrSellOrderRequest(user_id, options),
            "place request",
            this.logger
        );
    }

    async cancelBuyOrSellOrderRequest(
        user_id: string,
        options: t.CancelSellOrBuyOrderRequestOptions
    ): Promise<QD.QuidaxResponse<QD.SellOrBuyOrderRequestResponse>> {
        return executeQuidaxCall(
            () => this.quidax.cancelBuyOrSellOrderRequest(user_id, options),
            "cancel request",
            this.logger
        );
    }

    async getAllOrders(
        user_id: string,
        options: t.GetOrderListOptions
    ): Promise<QD.QuidaxResponse<QD.GetOrderListResponse>> {
        return executeQuidaxCall(
            () => this.quidax.getAllOrders(user_id, options),
            "get order list",
            this.logger
        );
    }

    async getOrderRecord(
        options: t.GetOrderRecordOptions
    ): Promise<QD.QuidaxResponse<QD.GetOrderRecordResponse>> {
        return executeQuidaxCall(
            () => this.quidax.getOrderRecord(options),
            "get order",
            this.logger
        );
    }

    async getOrderBookItemsForAMarket(
        options: t.GetOrderBookItemsForAMarketOptions
    ): Promise<QD.QuidaxResponse<QD.GetOrderBookItemsForAMarketResponse>> {
        return executeQuidaxCall(
            () => this.quidax.getOrderBookItemsForAMarket(options),
            "get order book items",
            this.logger
        );
    }

    async instantOrdersRequery(
        options: t.InstantOrdersRequeryOptions
    ): Promise<QD.QuidaxResponse<QD.InstantOrderResponse>> {
        return executeQuidaxCall(
            () => this.quidax.instantOrdersRequery(options),
            "retrieve order record",
            this.logger
        );
    }
}
