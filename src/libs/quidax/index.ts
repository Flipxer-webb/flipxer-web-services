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

    /************************** Order  *************************/

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
                url: `/users/me/instant_orders/${options.instant_order_id}`,
                method: "GET",
            };
            const resp = await this.axios<
                t.QuidaxResponse<t.InstantOrderResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError("Failed to verify bvn");
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
