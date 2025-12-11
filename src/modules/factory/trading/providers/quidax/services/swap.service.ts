import * as QD from "@/libs/quidax";
import { Logger } from "@nestjs/common";
import * as t from "../types";
import { executeQuidaxCall } from "./error-handler";

/**
 * Quidax Swap Service - Handles instant swap operations
 */
export class QuidaxSwapService {
    private readonly logger = new Logger(QuidaxSwapService.name);
    constructor(private readonly quidax: QD.QuidaxLib) {}

    async createInstantSwapRequest(
        user_id: string,
        options: t.CreateInstantSwapRequestOptions
    ): Promise<QD.QuidaxResponse<QD.CreateInstantSwapRequestResponse>> {
        return executeQuidaxCall(
            () => this.quidax.createInstantSwapRequest(user_id, options),
            "create instant swap",
            this.logger
        );
    }

    async confirmInstantSwap(
        options: t.ConfirmInstantSwapOptions
    ): Promise<QD.QuidaxResponse<QD.ConfirmInstantSwapRequestResponse>> {
        return executeQuidaxCall(
            () => this.quidax.confirmInstantSwap(options),
            "confirm instant swap",
            this.logger
        );
    }

    async refreshInstantSwapQuote(
        user_id: string,
        quotation_id: string,
        options: t.RefreshInstantSwapOptions
    ): Promise<QD.QuidaxResponse<QD.RefreshInstantSwapResponse>> {
        return executeQuidaxCall(
            () => this.quidax.refreshInstantSwapQuote(user_id, quotation_id, options),
            "refresh instant swap",
            this.logger
        );
    }

    async getSwapTransaction(
        options: t.GetSwapTransactionOptions
    ): Promise<QD.QuidaxResponse<QD.GetSwapTransactionResponse>> {
        return executeQuidaxCall(
            () => this.quidax.getSwapTransaction(options),
            "get swap transaction",
            this.logger
        );
    }

    async getSwapTransactionList(
        user_id: string
    ): Promise<QD.QuidaxResponse<QD.GetSwapTransactionListResponse>> {
        return executeQuidaxCall(
            () => this.quidax.getSwapTransactionList(user_id),
            "get swap transaction list",
            this.logger
        );
    }
}
