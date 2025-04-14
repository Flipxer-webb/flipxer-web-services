import * as e from "./errors";
import Axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from "axios";
export * from "./errors";
export * from "./types";
import * as t from "./types";

export class QuidaxLib {
    constructor(protected instanceOptions: t.QuidaxOptions) {}

    private axios: AxiosInstance = Axios.create({
        baseURL: this.instanceOptions.baseURL,
        headers: {
            Authorization: `Bearer ${this.instanceOptions.api_secret}`,
        },
    });

    private handleQuidaxError(error: AxiosError<any>) {
        switch (true) {
            case error.response?.status == 401: {
                throw new e.QuidaxAuthorizationError(error.response.data.error);
            }
            case error.response?.status == 400: {
                throw new e.QuidaxValidationError(error.response.data.error);
            }

            case error.response?.status == 404: {
                throw new e.QuidaxNotFoundError(error.response.data.error);
            }

            case error.response?.status == 429: {
                throw new e.QuidaxTooManyRequestError(
                    error.response.data.error
                );
            }

            default: {
                const err = new e.QuidaxGenericError(
                    error.response?.data?.error || error.response?.statusText
                );
                err.status = error.response?.status;
                throw err;
            }
        }
    }

    /************************** Account  *************************/

    /**
     *
     * @param options query options
     * @returns account detail
     * @description create account for registered user or business
     */
    async createSubAccount(
        options: t.CreateSubAccountOptions
    ): Promise<t.QuidaxResponse<t.CreateSubAccountResponse>> {
        try {
            const requestOptions: AxiosRequestConfig<t.CreateSubAccountOptions> =
                {
                    url: `/users`,
                    method: "POST",
                    data: options,
                };
            const resp = await this.axios<
                t.QuidaxResponse<t.CreateSubAccountResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError("Failed to create account");
                error.status = 500;
                throw error;
            }
            return {
                status: resp.data.status,
                message: resp.data.message,
                data: resp.data.data,
            };
        } catch (error) {
            this.handleQuidaxError(error);
        }
    }

    /**
     *
     * @param options query options
     * @returns account detail
     * @description get account detail
     */
    async getAccountDetail(
        options: t.GetAccountDetailOptions
    ): Promise<t.QuidaxResponse<t.GetAccountDetailResponse>> {
        try {
            const requestOptions: AxiosRequestConfig = {
                url: `/users/${options.user_id}`,
                method: "GET",
            };
            const resp = await this.axios<
                t.QuidaxResponse<t.GetAccountDetailResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError("Failed to get account detail");
                error.status = 500;
                throw error;
            }
            return {
                status: resp.data.status,
                message: resp.data.message,
                data: resp.data.data,
            };
        } catch (error) {
            this.handleQuidaxError(error);
        }
    }

    /************************** Wallet  *************************/

    /**
     *
     * @param options query options
     * @returns user wallets
     * @description Get all wallets linked to authenticated user account
     */
    async getUserWalletList(
        options: t.GetUserWalletListOptions
    ): Promise<t.QuidaxResponse<t.GetUserWalletListResponse>> {
        try {
            const requestOptions: AxiosRequestConfig = {
                url: `/users/${options.user_id}/wallets`,
                method: "GET",
            };
            const resp = await this.axios<
                t.QuidaxResponse<t.GetUserWalletListResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError("Failed to get wallet list");
                error.status = 500;
                throw error;
            }
            return {
                status: resp.data.status,
                message: resp.data.message,
                data: resp.data.data,
            };
        } catch (error) {
            this.handleQuidaxError(error);
        }
    }

    /**
     *
     * @param options query options
     * @returns user wallet
     * @description Get a single wallet linked to an authenticated user
     */
    async getUserWallet(
        options: t.GetUserWalletOptions
    ): Promise<t.QuidaxResponse<t.GetUserWalletResponse>> {
        try {
            const requestOptions: AxiosRequestConfig = {
                url: `/users/${options.user_id}/wallets/${options.currency}`,
                method: "GET",
            };
            const resp = await this.axios<
                t.QuidaxResponse<t.GetUserWalletResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError("Failed to get user wallet");
                error.status = 500;
                throw error;
            }
            return {
                status: resp.data.status,
                message: resp.data.message,
                data: resp.data.data,
            };
        } catch (error) {
            this.handleQuidaxError(error);
        }
    }

    /**
     *
     * @param options query options
     * @returns payment address
     * @description Fetch default payment address for a wallet
     */
    async getPaymentAddress(
        options: t.GetPaymentAddressOptions
    ): Promise<t.QuidaxResponse<t.GetUserWalletResponse>> {
        try {
            const requestOptions: AxiosRequestConfig = {
                url: `/users/${options.user_id}/wallets/${options.currency}/address`,
                method: "GET",
            };
            const resp = await this.axios<
                t.QuidaxResponse<t.GetUserWalletResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError(
                    "Failed to get payment address"
                );
                error.status = 500;
                throw error;
            }
            return {
                status: resp.data.status,
                message: resp.data.message,
                data: resp.data.data,
            };
        } catch (error) {
            this.handleQuidaxError(error);
        }
    }

    /**
     *
     * @param options query options
     * @returns payment address list
     * @description Get the deposits addresses assigned to a wallet
     */
    async getPaymentAddressList(
        options: t.GetPaymentAddressListOptions
    ): Promise<t.QuidaxResponse<t.GetPaymentAddressListResponse>> {
        try {
            const requestOptions: AxiosRequestConfig = {
                url: `/users/${options.user_id}/wallets/${options.currency}/addresses`,
                method: "GET",
            };
            const resp = await this.axios<
                t.QuidaxResponse<t.GetPaymentAddressListResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError(
                    "Failed to get payment address list"
                );
                error.status = 500;
                throw error;
            }
            return {
                status: resp.data.status,
                message: resp.data.message,
                data: resp.data.data,
            };
        } catch (error) {
            this.handleQuidaxError(error);
        }
    }

    /**
     *
     * @param options query options
     * @returns payment address
     * @description Get details of a payment address by address id
     */
    async getPaymentAddressById(
        options: t.GetPaymentAddressByIdOptions
    ): Promise<t.QuidaxResponse<t.GetPaymentAddressByIdResponse>> {
        try {
            const requestOptions: AxiosRequestConfig = {
                url: `/users/${options.user_id}/wallets/${options.currency}/addresses/${options.address_id}`,
                method: "GET",
            };
            const resp = await this.axios<
                t.QuidaxResponse<t.GetPaymentAddressByIdResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError(
                    "Failed to get payment address"
                );
                error.status = 500;
                throw error;
            }
            return {
                status: resp.data.status,
                message: resp.data.message,
                data: resp.data.data,
            };
        } catch (error) {
            this.handleQuidaxError(error);
        }
    }

    /**
     *
     * @param options query options
     * @returns address
     * @description Create a Payment Address for a wallet, once you call the API, a wallet address would be created, then you would need to the listen to wallet.address.generated webhook with the wallet id to get the wallet address that has been created.
     */
    async createPaymentAddress(
        options: t.CreatePaymentAddressOptions
    ): Promise<t.QuidaxResponse<t.CreatePaymentAddressResponse>> {
        try {
            const requestOptions: AxiosRequestConfig<t.CreatePaymentAddressOptions> =
                {
                    url: `/users/${options.user_id}/wallets/${options.currency}/addresses`,
                    method: "POST",
                    data: options,
                };
            const resp = await this.axios<
                t.QuidaxResponse<t.CreatePaymentAddressResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError(
                    "Failed to create payment address"
                );
                error.status = 500;
                throw error;
            }
            return {
                status: resp.data.status,
                message: resp.data.message,
                data: resp.data.data,
            };
        } catch (error) {
            this.handleQuidaxError(error);
        }
    }

    /**
     *
     * @param options query options
     * @returns address with verification status
     * @description Verify address of a digital wallet
     */
    async verifyAddress(
        options: t.VerifyAddressOptions
    ): Promise<t.QuidaxResponse<t.VerifyAddressResponse>> {
        try {
            const requestOptions: AxiosRequestConfig = {
                url: `/${options.currency}/${options.address}/validate_address`,
                method: "GET",
            };
            const resp = await this.axios<
                t.QuidaxResponse<t.VerifyAddressResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError("Failed to verify address");
                error.status = 500;
                throw error;
            }
            return {
                status: resp.data.status,
                message: resp.data.message,
                data: resp.data.data,
            };
        } catch (error) {
            this.handleQuidaxError(error);
        }
    }

    /************************** Withdrawals  *************************/
    /*
      The Withdrawals A.P.I collection enables authenticated users to send cryptocurrency to internal or external wallets, 
    users can also cancel withdrawal requests within a 6-second window after initiating the withdrawal.
    */

    /**
     *
     * @param options query options
     * @returns withdrawal detail
     * @description initiates the withdrawal of an authenticated account
     */
    async createWithdrawerRequest(
        options: t.CreateWithdrawerRequestOptions
    ): Promise<t.QuidaxResponse<t.CreateWithdrawerRequestResponse>> {
        try {
            const requestOptions: AxiosRequestConfig<t.CreateWithdrawerRequestOptions> =
                {
                    url: `/users/${options.user_id}/withdraw`,
                    method: "POST",
                    data: options,
                };
            const resp = await this.axios<
                t.QuidaxResponse<t.CreateWithdrawerRequestResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError(
                    "Failed to initiate withdrawer"
                );
                error.status = 500;
                throw error;
            }
            return {
                status: resp.data.status,
                message: resp.data.message,
                data: resp.data.data,
            };
        } catch (error) {
            this.handleQuidaxError(error);
        }
    }

    /**
     *
     * @param options query options
     * @returns n/a
     * @description cancel initiated withdrawal
     */
    async cancelWithdrawerRequest(
        options: t.CancelWithdrawerRequestOptions
    ): Promise<t.QuidaxResponse<t.CancelWithdrawerRequestResponse>> {
        try {
            const requestOptions: AxiosRequestConfig<t.CancelWithdrawerRequestOptions> =
                {
                    url: `/users/${options.user_id}/withdraws/${options.withdrawal_id}/cancel`,
                    method: "POST",
                    data: options,
                };
            const resp = await this.axios<
                t.QuidaxResponse<t.CancelWithdrawerRequestResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError("Failed to cancel withdrawer");
                error.status = 500;
                throw error;
            }
            return {
                status: resp.data.status,
                message: resp.data.message,
                data: resp.data.data,
            };
        } catch (error) {
            this.handleQuidaxError(error);
        }
    }

    /**
     *
     * @param options query options
     * @returns withdrawer list
     * @description fetch all withdrawals related to the authenticated user.
     */
    async getWithdrawerList(
        user_id: string,
        options: t.WithdrawalListOptions
    ): Promise<t.QuidaxResponse<t.WithdrawalListResponse>> {
        try {
            const requestOptions: AxiosRequestConfig<t.WithdrawalListOptions> =
                {
                    url: `/users/${user_id}/withdraws`,
                    method: "GET",
                    params: options,
                };
            const resp = await this.axios<
                t.QuidaxResponse<t.WithdrawalListResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError(
                    "Failed to get withdrawer list"
                );
                error.status = 500;
                throw error;
            }
            return {
                status: resp.data.status,
                message: resp.data.message,
                data: resp.data.data,
            };
        } catch (error) {
            this.handleQuidaxError(error);
        }
    }

    /**
     *
     * @param options query options
     * @returns withdrawer detail
     * @description fetch a withdrawal object, related to the user
     */
    async getWithdrawerDetail(
        options: t.WithdrawerDetailOptions
    ): Promise<t.QuidaxResponse<t.WithdrawerDetailResponse>> {
        try {
            const requestOptions: AxiosRequestConfig<t.WithdrawalListOptions> =
                {
                    url: `/users/${options.user_id}/withdraws/${options.withdrawal_id}`,
                    method: "GET",
                };
            const resp = await this.axios<
                t.QuidaxResponse<t.WithdrawerDetailResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError(
                    "Failed to get withdrawer detail"
                );
                error.status = 500;
                throw error;
            }
            return {
                status: resp.data.status,
                message: resp.data.message,
                data: resp.data.data,
            };
        } catch (error) {
            this.handleQuidaxError(error);
        }
    }

    /**
     *
     * @param options query options
     * @returns withdrawer detail
     * @description fetch a withdrawal object, related to the user by withdrawer reference
     */
    async getWithdrawerByReference(
        options: t.WithdrawerRecordByReferenceOptions
    ): Promise<t.QuidaxResponse<t.WithdrawerRecordByReferenceResponse>> {
        try {
            const requestOptions: AxiosRequestConfig<t.WithdrawerRecordByReferenceOptions> =
                {
                    url: `/users/${options.user_id}/withdraws/reference/${options.reference}`,
                    method: "GET",
                };
            const resp = await this.axios<
                t.QuidaxResponse<t.WithdrawerRecordByReferenceResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError("Failed to get withdrawer");
                error.status = 500;
                throw error;
            }
            return {
                status: resp.data.status,
                message: resp.data.message,
                data: resp.data.data,
            };
        } catch (error) {
            this.handleQuidaxError(error);
        }
    }

    /************************** Fees  *************************/
    /**
     *
     * @param options query options
     * @returns withdrawer fee list
     * @description withdrawal fee for a specific currency.
     */
    async getWithdrawerFees(
        options: t.WithdrawerFeesOptions
    ): Promise<t.QuidaxResponse<t.WithdrawerFeesResponse>> {
        try {
            const requestOptions: AxiosRequestConfig<t.WithdrawerFeesOptions> =
                {
                    url: `/fee`,
                    method: "GET",
                    params: options,
                };
            const resp = await this.axios<
                t.QuidaxResponse<t.WithdrawerFeesResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError("Failed to get withdrawer");
                error.status = 500;
                throw error;
            }
            return {
                status: resp.data.status,
                message: resp.data.message,
                data: resp.data.data,
            };
        } catch (error) {
            this.handleQuidaxError(error);
        }
    }

    /************************** Order  *************************/

    /**
     *
     * @param options query options
     * @returns order
     * @description Create a sell or buy order for the authenticated user
     */
    async buyOrSellOrderRequest(
        user_id: string,
        options: t.SellOrBuyOrderRequestOptions
    ): Promise<t.QuidaxResponse<t.SellOrBuyOrderRequestResponse>> {
        try {
            const requestOptions: AxiosRequestConfig<t.SellOrBuyOrderRequestOptions> =
                {
                    url: `/users/${user_id}/orders`,
                    method: "POST",
                    data: options,
                };
            const resp = await this.axios<
                t.QuidaxResponse<t.SellOrBuyOrderRequestResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError("Failed to place order");
                error.status = 500;
                throw error;
            }
            return {
                status: resp.data.status,
                message: resp.data.message,
                data: resp.data.data,
            };
        } catch (error) {
            this.handleQuidaxError(error);
        }
    }

    /**
     *
     * @param options query options
     * @returns order
     * @description Cancels an order tethered to the authenticated user
     */
    async cancelBuyOrSellOrderRequest(
        user_id: string,
        options: t.CancelSellOrBuyOrderRequestOptions
    ): Promise<t.QuidaxResponse<t.SellOrBuyOrderRequestResponse>> {
        try {
            const requestOptions: AxiosRequestConfig<t.CancelSellOrBuyOrderRequestOptions> =
                {
                    url: `/users/${user_id}/orders/${options.order_id}/cancel`,
                    method: "POST",
                };
            const resp = await this.axios<
                t.QuidaxResponse<t.SellOrBuyOrderRequestResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError("Failed to cancel order");
                error.status = 500;
                throw error;
            }
            return {
                status: resp.data.status,
                message: resp.data.message,
                data: resp.data.data,
            };
        } catch (error) {
            this.handleQuidaxError(error);
        }
    }

    /**
     *
     * @param options query options
     * @returns orders
     * @description Fetch all orders tethered to the authenticated user
     */
    async getAllOrders(
        user_id: string,
        options: t.GetOrderListOptions
    ): Promise<t.QuidaxResponse<t.GetOrderListResponse>> {
        try {
            const requestOptions: AxiosRequestConfig<t.GetOrderListOptions> = {
                url: `/users/${user_id}/orders`,
                method: "GET",
                params: options,
            };
            const resp = await this.axios<
                t.QuidaxResponse<t.GetOrderListResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError("Failed to get order list");
                error.status = 500;
                throw error;
            }
            return {
                status: resp.data.status,
                message: resp.data.message,
                data: resp.data.data,
            };
        } catch (error) {
            this.handleQuidaxError(error);
        }
    }

    /**
     *
     * @param options query options
     * @returns order
     * @description Fetch order tethered to the authenticated user
     */
    async getOrderRecord(
        options: t.GetOrderRecordOptions
    ): Promise<t.QuidaxResponse<t.GetOrderRecordResponse>> {
        try {
            const requestOptions: AxiosRequestConfig<t.GetOrderRecordOptions> =
                {
                    url: `/users/${options.user_id}/orders/${options.order_id}`,
                    method: "GET",
                };
            const resp = await this.axios<
                t.QuidaxResponse<t.GetOrderRecordResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError("Failed to get order");
                error.status = 500;
                throw error;
            }
            return {
                status: resp.data.status,
                message: resp.data.message,
                data: resp.data.data,
            };
        } catch (error) {
            this.handleQuidaxError(error);
        }
    }

    /************************** Instant Order  *************************/

    /**
     *
     * @param instant_order_id query options
     * @returns order detail
     * @description Get order detail
     */
    async instantOrdersRequery(
        options: t.InstantOrdersRequeryOptions
    ): Promise<t.QuidaxResponse<t.InstantOrderResponse>> {
        try {
            const requestOptions: AxiosRequestConfig = {
                url: `/users/${options.user_id}/instant_orders/${options.instant_order_id}`,
                method: "GET",
            };
            const resp = await this.axios<
                t.QuidaxResponse<t.InstantOrderResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError("Failed to get order");
                error.status = 500;
                throw error;
            }
            return {
                status: resp.data.status,
                message: resp.data.message,
                data: resp.data.data,
            };
        } catch (error) {
            this.handleQuidaxError(error);
        }
    }

    /*********************** Instant swap ****************************/
    /* 
        The Instant Swap Collection feature lets users exchange one type of cryptocurrency for another or fiat.
    */

    /**
     *
     * @param options query options
     * @returns swap quote
     * @description generate an instant swap quotation. note that the instant swap quotation is valid for only
     * 15 seconds. To refresh the swap and obtain a new quotation, you can use the Refresh Instant Swap endpoint
     */
    async createInstantSwapRequest(
        user_id: string,
        options: t.CreateInstantSwapRequestOptions
    ): Promise<t.QuidaxResponse<t.CreateInstantSwapRequestResponse>> {
        try {
            const requestOptions: AxiosRequestConfig<t.CreateInstantSwapRequestOptions> =
                {
                    url: `/users/${user_id}/swap_quotation`,
                    method: "POST",
                    data: options,
                };
            const resp = await this.axios<
                t.QuidaxResponse<t.CreateInstantSwapRequestResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError("Failed to create swap quote");
                error.status = 500;
                throw error;
            }
            return {
                status: resp.data.status,
                message: resp.data.message,
                data: resp.data.data,
            };
        } catch (error) {
            this.handleQuidaxError(error);
        }
    }

    /**
     *
     * @param options query options
     * @returns swap quote
     * @description used to confirm an instant swap quotation.
     */
    async confirmInstantSwap(
        options: t.ConfirmInstantSwapOptions
    ): Promise<t.QuidaxResponse<t.ConfirmInstantSwapRequestResponse>> {
        try {
            const requestOptions: AxiosRequestConfig<t.ConfirmInstantSwapOptions> =
                {
                    url: `/users/${options.user_id}/swap_quotation/${options.quotation_id}`,
                    method: "POST",
                };
            const resp = await this.axios<
                t.QuidaxResponse<t.ConfirmInstantSwapRequestResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError("Failed to confirm quote");
                error.status = 500;
                throw error;
            }
            return {
                status: resp.data.status,
                message: resp.data.message,
                data: resp.data.data,
            };
        } catch (error) {
            this.handleQuidaxError(error);
        }
    }
}
