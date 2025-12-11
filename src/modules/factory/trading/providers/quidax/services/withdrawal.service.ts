import * as QD from "@/libs/quidax";
import { Logger } from "@nestjs/common";
import * as t from "../types";
import { executeQuidaxCall } from "./error-handler";

/**
 * Quidax Withdrawal Service - Handles withdrawal operations
 */
export class QuidaxWithdrawalService {
    private readonly logger = new Logger(QuidaxWithdrawalService.name);
    constructor(private readonly quidax: QD.QuidaxLib) {}

    async createWithdrawerRequest(
        options: t.CreateWithdrawerRequestOptions
    ): Promise<QD.QuidaxResponse<QD.CreateWithdrawerRequestResponse>> {
        return executeQuidaxCall(
            () => this.quidax.createWithdrawerRequest(options),
            "create withdrawer",
            this.logger
        );
    }

    async cancelWithdrawerRequest(
        options: t.CancelWithdrawerRequestOptions
    ): Promise<QD.QuidaxResponse<QD.CancelWithdrawerRequestResponse>> {
        return executeQuidaxCall(
            () => this.quidax.cancelWithdrawerRequest(options),
            "cancel withdrawer",
            this.logger
        );
    }

    async getWithdrawerList(
        user_id: string,
        options: t.WithdrawalListOptions
    ): Promise<QD.QuidaxResponse<QD.WithdrawalListResponse>> {
        return executeQuidaxCall(
            () => this.quidax.getWithdrawerList(user_id, options),
            "get withdrawer list",
            this.logger
        );
    }

    async getWithdrawerDetail(
        options: t.WithdrawerDetailOptions
    ): Promise<QD.QuidaxResponse<QD.WithdrawerDetailResponse>> {
        return executeQuidaxCall(
            () => this.quidax.getWithdrawerDetail(options),
            "get withdrawer detail",
            this.logger
        );
    }

    async getWithdrawerByReference(
        options: t.WithdrawerRecordByReferenceOptions
    ): Promise<QD.QuidaxResponse<QD.WithdrawerRecordByReferenceResponse>> {
        return executeQuidaxCall(
            () => this.quidax.getWithdrawerByReference(options),
            "get withdrawer",
            this.logger
        );
    }

    async getWithdrawerFees(
        options: t.WithdrawerFeesOptions
    ): Promise<QD.QuidaxResponse<QD.WithdrawerFeesResponse>> {
        return executeQuidaxCall(
            () => this.quidax.getWithdrawerFees(options),
            "get withdrawer fee",
            this.logger
        );
    }
}
