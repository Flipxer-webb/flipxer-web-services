import * as QD from "@/libs/quidax";
import { HttpStatus, Logger } from "@nestjs/common";
import * as t from "../types";
import * as e from "../errors";

export class QuidaxService {
    private readonly logger = new Logger(QuidaxService.name);
    constructor(private readonly quidax: QD.QuidaxLib) {}

    async createSubAccount(
        options: t.CreateSubAccountOptions
    ): Promise<QD.QuidaxResponse<QD.CreateSubAccountResponse>> {
        try {
            const resp = await this.quidax.createSubAccount(options);

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to create account`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to create account. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to create account",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async getAccountDetail(
        options: t.GetAccountDetailOptions
    ): Promise<QD.QuidaxResponse<QD.GetAccountDetailResponse>> {
        try {
            const resp = await this.quidax.getAccountDetail(options);

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to get account`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to get account. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to get account",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async getUserWalletList(
        options: t.GetUserWalletListOptions
    ): Promise<QD.QuidaxResponse<QD.GetUserWalletListResponse>> {
        try {
            const resp = await this.quidax.getUserWalletList(options);

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to get wallet list`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to get wallet list. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to get wallet list",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async getUserWallet(
        options: t.GetUserWalletOptions
    ): Promise<QD.QuidaxResponse<QD.GetUserWalletResponse>> {
        try {
            const resp = await this.quidax.getUserWallet(options);

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to get wallet`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to get wallet. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to get wallet",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async getPaymentAddress(
        options: t.GetUserWalletOptions
    ): Promise<QD.QuidaxResponse<QD.GetUserWalletResponse>> {
        try {
            const resp = await this.quidax.getPaymentAddress(options);

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to get address`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to get address. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to get address",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async getPaymentAddressList(
        options: t.GetUserWalletOptions
    ): Promise<QD.QuidaxResponse<QD.GetPaymentAddressListResponse>> {
        try {
            const resp = await this.quidax.getPaymentAddressList(options);

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to get address list`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to get address list. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to get address list",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async getPaymentAddressById(
        options: t.GetPaymentAddressByIdOptions
    ): Promise<QD.QuidaxResponse<QD.GetPaymentAddressByIdResponse>> {
        try {
            const resp = await this.quidax.getPaymentAddressById(options);

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to get address`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to get address. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to get address",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async createPaymentAddress(
        options: t.CreatePaymentAddressOptions
    ): Promise<QD.QuidaxResponse<QD.CreatePaymentAddressResponse>> {
        try {
            const resp = await this.quidax.createPaymentAddress(options);

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to create payment address`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to create payment address. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to create payment address",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async verifyAddress(
        options: t.VerifyAddressOptions
    ): Promise<QD.QuidaxResponse<QD.VerifyAddressResponse>> {
        try {
            const resp = await this.quidax.verifyAddress(options);

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to verify address`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to verify address. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to verify address",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async createWithdrawerRequest(
        options: t.CreateWithdrawerRequestOptions
    ): Promise<QD.QuidaxResponse<QD.CreateWithdrawerRequestResponse>> {
        try {
            const resp = await this.quidax.createWithdrawerRequest(options);

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to create withdrawer`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to create withdrawer. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to create withdrawer",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async cancelWithdrawerRequest(
        options: t.CancelWithdrawerRequestOptions
    ): Promise<QD.QuidaxResponse<QD.CancelWithdrawerRequestResponse>> {
        try {
            const resp = await this.quidax.cancelWithdrawerRequest(options);

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to cancel withdrawer`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to cancel withdrawer. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to cancel withdrawer",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async getWithdrawerList(
        user_id: string,
        options: t.WithdrawalListOptions
    ): Promise<QD.QuidaxResponse<QD.WithdrawalListResponse>> {
        try {
            const resp = await this.quidax.getWithdrawerList(user_id, options);

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to withdrawer list`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to withdrawer list. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to withdrawer list",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async getWithdrawerDetail(
        options: t.WithdrawerDetailOptions
    ): Promise<QD.QuidaxResponse<QD.WithdrawerDetailResponse>> {
        try {
            const resp = await this.quidax.getWithdrawerDetail(options);

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to withdrawer detail`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to withdrawer detail. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to withdrawer detail",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async getWithdrawerByReference(
        options: t.WithdrawerRecordByReferenceOptions
    ): Promise<QD.QuidaxResponse<QD.WithdrawerRecordByReferenceResponse>> {
        try {
            const resp = await this.quidax.getWithdrawerByReference(options);

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to get withdrawer`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to get withdrawer. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to get withdrawer",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async getWithdrawerFees(
        options: t.WithdrawerFeesOptions
    ): Promise<QD.QuidaxResponse<QD.WithdrawerFeesResponse>> {
        try {
            const resp = await this.quidax.getWithdrawerFees(options);

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to get withdrawer fee`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to get withdrawer fee. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to get withdrawer fee",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async buyOrSellOrderRequest(
        user_id: string,
        options: t.SellOrBuyOrderRequestOptions
    ): Promise<QD.QuidaxResponse<QD.SellOrBuyOrderRequestResponse>> {
        try {
            const resp = await this.quidax.buyOrSellOrderRequest(
                user_id,
                options
            );

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to place request`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to place request. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to place request",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async cancelBuyOrSellOrderRequest(
        user_id: string,
        options: t.CancelSellOrBuyOrderRequestOptions
    ): Promise<QD.QuidaxResponse<QD.SellOrBuyOrderRequestResponse>> {
        try {
            const resp = await this.quidax.cancelBuyOrSellOrderRequest(
                user_id,
                options
            );

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to place request`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to place request. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to place request",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async getAllOrders(
        user_id: string,
        options: t.GetOrderListOptions
    ): Promise<QD.QuidaxResponse<QD.GetOrderListResponse>> {
        try {
            const resp = await this.quidax.getAllOrders(user_id, options);

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to get order list`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to get order list. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to get order list",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async getOrderRecord(
        options: t.GetOrderRecordOptions
    ): Promise<QD.QuidaxResponse<QD.GetOrderRecordResponse>> {
        try {
            const resp = await this.quidax.getOrderRecord(options);

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to get order`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to get order. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to get order",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async createInstantSwapRequest(
        user_id: string,
        options: t.CreateInstantSwapRequestOptions
    ): Promise<QD.QuidaxResponse<QD.CreateInstantSwapRequestResponse>> {
        try {
            const resp = await this.quidax.createInstantSwapRequest(
                user_id,
                options
            );

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to create instant swap`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to create instant swap. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to create instant swap",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async confirmInstantSwap(
        options: t.ConfirmInstantSwapOptions
    ): Promise<QD.QuidaxResponse<QD.ConfirmInstantSwapRequestResponse>> {
        try {
            const resp = await this.quidax.confirmInstantSwap(options);

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to confirm instant swap`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to confirm instant swap. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to confirm instant swap",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async refreshInstantSwapQuote(
        user_id: string,
        quotation_id: string,
        options: t.RefreshInstantSwapOptions
    ): Promise<QD.QuidaxResponse<QD.RefreshInstantSwapResponse>> {
        try {
            const resp = await this.quidax.refreshInstantSwapQuote(
                user_id,
                quotation_id,
                options
            );

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to refresh instant swap`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to refresh instant swap. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to refresh instant swap",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async getSwapTransaction(
        options: t.GetSwapTransactionOptions
    ): Promise<QD.QuidaxResponse<QD.GetSwapTransactionResponse>> {
        try {
            const resp = await this.quidax.getSwapTransaction(options);

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to get swap transaction`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to get swap transaction. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to get swap transaction",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async getSwapTransactionList(
        user_id: string
    ): Promise<QD.QuidaxResponse<QD.GetSwapTransactionListResponse>> {
        try {
            const resp = await this.quidax.getSwapTransactionList(user_id);

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to get swap transaction list`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to get swap transaction list. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to get swap transaction list",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async getMarketList(): Promise<
        QD.QuidaxResponse<QD.GetMarketListResponse>
    > {
        try {
            const resp = await this.quidax.getMarketList();

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to get market list`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to get market list. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to get market list",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async getMarketTickers(): Promise<
        QD.QuidaxResponse<QD.GetMarketTickersResponse>
    > {
        try {
            const resp = await this.quidax.getMarketTickers();

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to get market ticker`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to get market ticker. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to get market ticker",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async getSingleMarketTicker(
        currency: string
    ): Promise<QD.QuidaxResponse<QD.GetMarketTickerResponse>> {
        try {
            const resp = await this.quidax.getSingleMarketTicker(currency);

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to get market ticker`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to get market ticker. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to get market ticker",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async getOrderBookItemsForAMarket(
        options: t.GetOrderBookItemsForAMarketOptions
    ): Promise<QD.QuidaxResponse<QD.GetOrderBookItemsForAMarketResponse>> {
        try {
            const resp = await this.quidax.getOrderBookItemsForAMarket(options);

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to get order book items`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to get order book items. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to get order book items",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async instantOrdersRequery(
        options: t.InstantOrdersRequeryOptions
    ): Promise<QD.QuidaxResponse<QD.InstantOrderResponse>> {
        try {
            const resp = await this.quidax.instantOrdersRequery(options);

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to retrieve order record`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to retrieve order record. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to retrieve order record",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async getPaymentMethods(
        options: t.PaymentMethodsOptions
    ): Promise<QD.QuidaxResponse<any>> {
        try {
            const resp = await this.quidax.getPaymentMethods(options);

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to retrieve payment methods`,
                    HttpStatus.BAD_REQUEST
                );
            }
            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to payment methods. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to payment methods",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async getPurchaseLimitForBuy(
        options: t.PurchaseLimitBuyOptions
    ): Promise<QD.QuidaxResponse<any>> {
        try {
            const resp = await this.quidax.getPurchaseLimitForBuy(options);

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to retrieve purchase limit`,
                    HttpStatus.BAD_REQUEST
                );
            }
            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to purchase limit. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to purchase limit",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async getPurchaseLimitForSell(
        options: t.PurchaseLimitSellOptions
    ): Promise<QD.QuidaxResponse<any>> {
        try {
            const resp = await this.quidax.getPurchaseLimitForSell(options);

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to retrieve purchase limit`,
                    HttpStatus.BAD_REQUEST
                );
            }
            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to purchase limit. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to purchase limit",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async getPurchaseQuoteForBuy(
        options: t.PurchaseQuoteBuyOptions
    ): Promise<QD.QuidaxResponse<any>> {
        try {
            const resp = await this.quidax.getPurchaseQuoteForBuy(options);

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to retrieve purchase quote`,
                    HttpStatus.BAD_REQUEST
                );
            }
            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to purchase quote. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to purchase quote",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async getPurchaseQuoteForSell(
        options: t.PurchaseQuoteSellOptions
    ): Promise<QD.QuidaxResponse<any>> {
        try {
            const resp = await this.quidax.getPurchaseQuoteForSell(options);

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to retrieve purchase quote`,
                    HttpStatus.BAD_REQUEST
                );
            }
            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to purchase quote. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to purchase quote",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }
}
