import * as QD from "@/libs/quidax";
import { Logger } from "@nestjs/common";
import { executeQuidaxCall } from "./error-handler";

/**
 * Quidax Market Service - Handles market data operations
 */
export class QuidaxMarketService {
    private readonly logger = new Logger(QuidaxMarketService.name);
    constructor(private readonly quidax: QD.QuidaxLib) {}

    async getMarketList(): Promise<QD.QuidaxResponse<QD.GetMarketListResponse>> {
        return executeQuidaxCall(
            () => this.quidax.getMarketList(),
            "get market list",
            this.logger
        );
    }

    async getMarketTickers(): Promise<QD.QuidaxResponse<QD.GetMarketTickersResponse>> {
        return executeQuidaxCall(
            () => this.quidax.getMarketTickers(),
            "get market ticker",
            this.logger
        );
    }

    async getSingleMarketTicker(
        currency: string
    ): Promise<QD.QuidaxResponse<QD.GetMarketTickerResponse>> {
        return executeQuidaxCall(
            () => this.quidax.getSingleMarketTicker(currency),
            "get market ticker",
            this.logger
        );
    }
}
