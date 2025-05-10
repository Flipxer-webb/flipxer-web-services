import Axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from "axios";
import {
    PaystackAuthorizationError,
    PaystackGenericError,
    PaystackNotFoundError,
    PaystackUnprocessableError,
    PaystackValidationError,
} from "./errors";
import {
    BankListOptions,
    BankListResponseData,
    PaystackOptions,
    PaystackResponse,
    ResolveBankAccountOptions,
    ResolveBankAccountResponse,
} from "./interfaces";
import {
    IPaystackInitializePaymentDetail,
    PaystackInitializePaymentResponse,
    VerifyTransactionResponseData,
} from "./interfaces/transaction";
import {
    InitiateTransferOptions,
    InitiateTransferResponseData,
} from "./interfaces/transfer";

export * from "./errors";
export * from "./interfaces";

export class PaystackLib {
    private axios: AxiosInstance = Axios.create({
        baseURL: this.instanceOptions.baseUrl,
        headers: {
            Authorization: `Bearer ${this.instanceOptions.secretKey}`,
            "Content-Type": "application/json",
        },
    });
    constructor(protected instanceOptions: PaystackOptions) {}

    private handlePaystackError(error: AxiosError<any>) {
        switch (true) {
            case error.response?.status == 401: {
                throw new PaystackAuthorizationError(
                    error.response.data.message
                );
            }
            case error.response?.status == 400: {
                throw new PaystackValidationError(error.response.data.message);
            }

            case error.response?.status == 404: {
                throw new PaystackNotFoundError(error.response.data.message);
            }

            case error.response?.status == 422: {
                throw new PaystackUnprocessableError(
                    error.response.data.message
                );
            }

            default: {
                const err = new PaystackGenericError(
                    error.response?.data?.message
                );
                err.status = error.response?.status;
                throw err;
            }
        }
    }

    /**
     *
     * @param options query options
     * @returns list of banks
     * @description Get a list of all supported banks and their properties
     */
    async getBanks(options?: BankListOptions) {
        try {
            const requestOptions: AxiosRequestConfig = {
                method: "GET",
                url: "/bank",
                params: options,
            };
            const { data } = await this.axios<
                PaystackResponse<BankListResponseData[]>
            >(requestOptions);
            return data;
        } catch (error) {
            if (!Axios.isAxiosError(error)) {
                throw error;
            }
            this.handlePaystackError(error);
        }
    }

    /**
     *
     * @param options query options
     * @returns Bank account details
     * @description Resolve a bank account number by retrieving the name of the account
     */
    async resolveBankAccount(options: ResolveBankAccountOptions) {
        try {
            const requestOptions: AxiosRequestConfig = {
                method: "GET",
                url: "/bank/resolve",
                params: options,
            };
            const { data } = await this.axios<
                PaystackResponse<ResolveBankAccountResponse>
            >(requestOptions);
            return data;
        } catch (error) {
            if (!Axios.isAxiosError(error)) {
                throw error;
            }
            this.handlePaystackError(error);
        }
    }

    /**
     *
     * @param options request body options
     * @returns Paystack Response data
     * @description Initiates a transfer request
     *  Read more in the [docs](https://paystack.com/docs/api/transfer/#initiate).
     */

    async initiateTransfer(options: InitiateTransferOptions) {
        try {
            const requestOptions: AxiosRequestConfig<InitiateTransferOptions> =
                {
                    method: "POST",
                    url: "/transfer",
                    data: options,
                };
            const { data } = await this.axios<
                PaystackResponse<InitiateTransferResponseData>
            >(requestOptions);
            return data;
        } catch (error) {
            if (!Axios.isAxiosError(error)) {
                throw error;
            }
            this.handlePaystackError(error);
        }
    }

    /**
     *
     * @param reference
     * @returns
     * @description verifies the status of a transaction
     */
    async verifyTransaction(reference: string) {
        try {
            const requestOptions: AxiosRequestConfig = {
                method: "GET",
                url: `/transaction/verify/${reference}`,
            };
            const { data } = await this.axios<
                PaystackResponse<VerifyTransactionResponseData>
            >(requestOptions);
            return data;
        } catch (error) {
            if (!Axios.isAxiosError(error)) {
                throw error;
            }
            this.handlePaystackError(error);
        }
    }

    /**
     *
     * @param IPaystackInitializePaymentDetail
     * @returns
     * @description initiate paystack payment
     */
    async initializePaymentTransaction(
        options: IPaystackInitializePaymentDetail
    ) {
        try {
            const requestOptions: AxiosRequestConfig = {
                method: "POST",
                url: `/transaction/initialize`,
                data: options,
            };
            const { data } = await this.axios<
                PaystackResponse<PaystackInitializePaymentResponse>
            >(requestOptions);
            return data;
        } catch (error) {
            if (!Axios.isAxiosError(error)) {
                throw error;
            }
            this.handlePaystackError(error);
        }
    }
}
