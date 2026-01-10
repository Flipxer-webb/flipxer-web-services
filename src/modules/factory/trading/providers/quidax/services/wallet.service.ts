import * as QD from "@/libs/quidax";
import { Logger } from "@nestjs/common";
import * as t from "../types";
import { executeQuidaxCall } from "./error-handler";

/**
 * Quidax Wallet Service - Handles wallet and payment address operations
 */
export class QuidaxWalletService {
    private readonly logger = new Logger(QuidaxWalletService.name);
    constructor(private readonly quidax: QD.QuidaxLib) { }

    async getUserWalletList(
        options: t.GetUserWalletListOptions
    ): Promise<QD.QuidaxResponse<QD.GetUserWalletListResponse>> {
        return executeQuidaxCall(
            () => this.quidax.getUserWalletList(options),
            "get wallet list",
            this.logger
        );
    }

    async getUserWallet(
        options: t.GetUserWalletOptions
    ): Promise<QD.QuidaxResponse<QD.GetUserWalletResponse>> {
        return executeQuidaxCall(
            () => this.quidax.getUserWallet(options),
            "get wallet",
            this.logger
        );
    }

    async getPaymentAddress(
        options: t.GetUserWalletOptions
    ): Promise<QD.QuidaxResponse<QD.GetUserWalletResponse>> {
        return executeQuidaxCall(
            () => this.quidax.getPaymentAddress(options),
            "get address",
            this.logger
        );
    }

    async getPaymentAddressList(
        options: t.GetUserWalletOptions
    ): Promise<QD.QuidaxResponse<QD.GetPaymentAddressListResponse>> {
        return executeQuidaxCall(
            () => this.quidax.getPaymentAddressList(options),
            "get address list",
            this.logger
        );
    }

    async getPaymentAddressById(
        options: t.GetPaymentAddressByIdOptions
    ): Promise<QD.QuidaxResponse<QD.GetPaymentAddressByIdResponse>> {
        return executeQuidaxCall(
            () => this.quidax.getPaymentAddressById(options),
            "get address",
            this.logger
        );
    }

    async createPaymentAddress(
        options: t.CreatePaymentAddressOptions
    ): Promise<QD.QuidaxResponse<QD.CreatePaymentAddressResponse>> {
        return executeQuidaxCall(
            () => this.quidax.createPaymentAddress(options),
            "create payment address",
            this.logger
        );
    }

    async verifyAddress(
        options: t.VerifyAddressOptions
    ): Promise<QD.QuidaxResponse<QD.VerifyAddressResponse>> {
        return executeQuidaxCall(
            () => this.quidax.verifyAddress(options),
            "verify address",
            this.logger
        );
    }

    async internalTransfer(
        user_id: string,
        options: t.InternalTransferOptions
    ): Promise<QD.QuidaxResponse<QD.InternalTransferResponse>> {
        return executeQuidaxCall(
            () => this.quidax.internalTransfer(user_id, options),
            "internal transfer",
            this.logger
        );
    }
}
