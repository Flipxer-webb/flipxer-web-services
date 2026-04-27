import * as e from "./errors";
import Axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from "axios";
export * from "./errors";
export * from "./types";
import * as t from "./types";
import { Logger } from "@nestjs/common";

export class QuidaxLib {
    constructor(protected instanceOptions: t.QuidaxOptions) { }

    // Quidax main API
    private readonly mainAxios: AxiosInstance = Axios.create({
        baseURL: this.instanceOptions.baseURL,
        headers: {
            Authorization: `Bearer ${this.instanceOptions.api_secret}`,
        },
    });

    // Quidax Ramp API
    private readonly rampAxios: AxiosInstance = Axios.create({
        baseURL: this.instanceOptions.rampBaseURL, // e.g., https://ramp-be.quidax.io/api/v1/merchants
        headers: {
            "x-private-key": this.instanceOptions.api_secret,
            Accept: "application/json",
        },
    });

    private handleQuidaxError(error: AxiosError<any>) {
        // Enhanced logging for debugging Quidax API issues
        const logger = new Logger("QuidaxLib");
        const status = error.response?.status;
        const data = error.response?.data;
        // Quidax sometimes returns a plain string body (e.g. throttling at 444).
        // Fall back through string body, statusText, and axios message so we
        // never log/throw with an empty <none> message.
        const responseMessage =
            (typeof data === "string" && data) ||
            data?.message ||
            error.response?.statusText ||
            error.message;

        logger.error(`Quidax API Error - Status: ${status}, URL: ${error.config?.url}`);
        logger.error(`Quidax API Error - Response: ${JSON.stringify(data)}`);
        logger.error(`Quidax API Error - Message: ${error.message}`);

        switch (true) {
            case status == 401: {
                throw new e.QuidaxAuthorizationError(responseMessage);
            }
            case status == 400: {
                // Preserve the Quidax error code for better debugging
                const errorCode = data?.data?.code;
                throw new e.QuidaxValidationError(responseMessage, errorCode);
            }

            case status == 404: {
                throw new e.QuidaxNotFoundError(responseMessage);
            }

            // Quidax emits HTTP 429 (standard) and HTTP 444 (their custom
            // throttling code with body "That's a bit too much request please throttle").
            // Treat both as the same retryable rate-limit class.
            case status == 429 || status == 444: {
                throw new e.QuidaxTooManyRequestError(responseMessage);
            }

            default: {
                logger.error(`Unknown Quidax error: ${error.message}`);
                const err = new e.QuidaxGenericError(responseMessage);

                err.status = status;
                throw err;
            }
        }
    }

    /**
     * UUID v4 regex pattern for validating Quidax sub-account IDs.
     * Also allows the special value "me" used for the master account.
     */
    private static readonly UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    /**
     * Validates that a user_id is either "me" or a valid UUID before making API calls.
     * Prevents invalid/mock IDs from hitting the Quidax API and producing confusing 404s.
     */
    private validateUserId(userId: string, context?: string): void {
        if (userId === "me") return;
        if (!QuidaxLib.UUID_REGEX.test(userId)) {
            const logger = new Logger("QuidaxLib");
            const contextSuffix = context ? ` in ${context}` : "";
            logger.error(`Invalid Quidax user_id detected: "${userId}"${contextSuffix}. Expected a UUID.`);
            throw new e.QuidaxValidationError(
                `Invalid sub-account ID: "${userId}". Expected a valid UUID.`,
                "INVALID_SUB_ACCOUNT_ID"
            );
        }
    }

    private encodePathSegment(value: string, fieldName: string): string {
        if (typeof value !== "string" || !value.trim()) {
            throw new e.QuidaxValidationError(
                `Invalid ${fieldName}. Expected a non-empty string.`,
                "INVALID_PATH_SEGMENT",
            );
        }

        if (/[/?#\\]/.test(value)) {
            throw new e.QuidaxValidationError(
                `Invalid ${fieldName}. Path separators are not allowed.`,
                "INVALID_PATH_SEGMENT",
            );
        }

        return encodeURIComponent(value.trim());
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
            const resp = await this.mainAxios<
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
     * @returns list of all sub-accounts
     * @description Get all sub-accounts for the authenticated master account
     */
    async getAllSubAccounts(): Promise<t.QuidaxResponse<t.IAccount[]>> {
        try {
            const requestOptions: AxiosRequestConfig = {
                url: `/users`,
                method: "GET",
            };
            const resp = await this.mainAxios<t.QuidaxResponse<t.IAccount[]>>(
                requestOptions
            );

            if (!resp.data) {
                const error = new e.QuidaxError("Failed to get sub-accounts");
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
     * @param email email address to search for
     * @returns sub-account with matching email or null
     * @description Find a sub-account by email address
     */
    async findSubAccountByEmail(email: string): Promise<t.IAccount | null> {
        const logger = new Logger("QuidaxLib");
        try {
            logger.log(`Finding sub-account by email: ${email}`);
            const result = await this.getAllSubAccounts();
            if (result.status === "success" && result.data) {
                logger.log(`getAllSubAccounts returned ${result.data.length} accounts`);
                // Log all emails for debugging E0101 issues
                const allEmails = result.data.map(acc => acc.email || '(no email)').join(', ');
                logger.debug(`Available account emails: ${allEmails}`);

                const account = result.data.find(
                    (acc) => acc.email?.toLowerCase() === email.toLowerCase()
                );
                if (account) {
                    logger.log(`Found matching account: ${account.id}`);
                } else {
                    logger.log(`No matching account found for email: ${email}`);
                }
                return account || null;
            }
            logger.warn(`getAllSubAccounts returned status: ${result.status}`);
            return null;
        } catch (error) {
            // Log but don't throw - return null to allow fallback to creation
            logger.error(`Error finding sub-account by email: ${error instanceof Error ? error.message : String(error)}`);
            return null;
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
        this.validateUserId(options.user_id, "getAccountDetail");
        try {
            const requestOptions: AxiosRequestConfig = {
                url: `/users/${options.user_id}`,
                method: "GET",
            };
            const resp = await this.mainAxios<
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
        this.validateUserId(options.user_id, "getUserWalletList");
        try {
            const requestOptions: AxiosRequestConfig = {
                url: `/users/${options.user_id}/wallets`,
                method: "GET",
            };
            const resp = await this.mainAxios<
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
        this.validateUserId(options.user_id, "getUserWallet");
        const safeUserId = this.encodePathSegment(options.user_id, "user_id");
        const safeCurrency = this.encodePathSegment(options.currency, "currency");
        try {
            const requestOptions: AxiosRequestConfig = {
                url: `/users/${safeUserId}/wallets/${safeCurrency}`,
                method: "GET",
            };
            const resp = await this.mainAxios<
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
        this.validateUserId(options.user_id, "getPaymentAddress");
        const safeUserId = this.encodePathSegment(options.user_id, "user_id");
        const safeCurrency = this.encodePathSegment(options.currency, "currency");
        try {
            const requestOptions: AxiosRequestConfig = {
                url: `/users/${safeUserId}/wallets/${safeCurrency}/address`,
                method: "GET",
            };
            const resp = await this.mainAxios<
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
        this.validateUserId(options.user_id, "getPaymentAddressList");
        try {
            const requestOptions: AxiosRequestConfig = {
                url: `/users/${options.user_id}/wallets/${options.currency}/addresses`,
                method: "GET",
            };
            const resp = await this.mainAxios<
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
        this.validateUserId(options.user_id, "getPaymentAddressById");
        try {
            const requestOptions: AxiosRequestConfig = {
                url: `/users/${options.user_id}/wallets/${options.currency}/addresses/${options.address_id}`,
                method: "GET",
            };
            const resp = await this.mainAxios<
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
        this.validateUserId(options.user_id, "createPaymentAddress");
        const safeUserId = this.encodePathSegment(options.user_id, "user_id");
        const safeCurrency = this.encodePathSegment(options.currency, "currency");
        try {
            const requestOptions: AxiosRequestConfig<t.CreatePaymentAddressOptions> =
            {
                url: `/users/${safeUserId}/wallets/${safeCurrency}/addresses`,
                method: "POST",
                data: options,
            };
            const resp = await this.mainAxios<
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
        const safeCurrency = this.encodePathSegment(options.currency, "currency");
        const safeAddress = this.encodePathSegment(options.address, "address");
        try {
            const requestOptions: AxiosRequestConfig = {
                url: `/${safeCurrency}/${safeAddress}/validate_address`,
                method: "GET",
                params: options.network ? { network: options.network } : undefined,
            };
            const resp = await this.mainAxios<
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
    async createWithdrawalRequest(
        options: t.CreateWithdrawerRequestOptions
    ): Promise<t.QuidaxResponse<t.CreateWithdrawerRequestResponse>> {
        this.validateUserId(options.user_id, "createWithdrawalRequest");
        try {
            const requestOptions: AxiosRequestConfig<t.CreateWithdrawerRequestOptions> =
            {
                url: `/users/${options.user_id}/withdraws`,
                method: "POST",
                data: options,
            };
            const resp = await this.mainAxios<
                t.QuidaxResponse<t.CreateWithdrawerRequestResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError(
                    "Failed to initiate withdrawal"
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
     * @deprecated Use createWithdrawalRequest instead.
     */
    async createWithdrawerRequest(
        options: t.CreateWithdrawerRequestOptions
    ): Promise<t.QuidaxResponse<t.CreateWithdrawerRequestResponse>> {
        return this.createWithdrawalRequest(options);
    }

    /**
     *
     * @param options query options
     * @returns n/a
     * @description cancel initiated withdrawal
     */
    async cancelWithdrawalRequest(
        options: t.CancelWithdrawerRequestOptions
    ): Promise<t.QuidaxResponse<t.CancelWithdrawerRequestResponse>> {
        this.validateUserId(options.user_id, "cancelWithdrawalRequest");
        try {
            const requestOptions: AxiosRequestConfig<t.CancelWithdrawerRequestOptions> =
            {
                url: `/users/${options.user_id}/withdraws/${options.withdrawal_id}/cancel`,
                method: "POST",
                data: options,
            };
            const resp = await this.mainAxios<
                t.QuidaxResponse<t.CancelWithdrawerRequestResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError("Failed to cancel withdrawal");
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
     * @deprecated Use cancelWithdrawalRequest instead.
     */
    async cancelWithdrawerRequest(
        options: t.CancelWithdrawerRequestOptions
    ): Promise<t.QuidaxResponse<t.CancelWithdrawerRequestResponse>> {
        return this.cancelWithdrawalRequest(options);
    }

    /**
     *
     * @param options query options
     * @returns withdrawer list
     * @description fetch all withdrawals related to the authenticated user.
     */
    async getWithdrawalList(
        user_id: string,
        options: t.WithdrawalListOptions
    ): Promise<t.QuidaxResponse<t.WithdrawalListResponse>> {
        this.validateUserId(user_id, "getWithdrawalList");
        try {
            const requestOptions: AxiosRequestConfig<t.WithdrawalListOptions> =
            {
                url: `/users/${user_id}/withdraws`,
                method: "GET",
                params: options,
            };
            const resp = await this.mainAxios<
                t.QuidaxResponse<t.WithdrawalListResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError(
                    "Failed to get withdrawal list"
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
     * @deprecated Use getWithdrawalList instead.
     */
    async getWithdrawerList(
        user_id: string,
        options: t.WithdrawalListOptions
    ): Promise<t.QuidaxResponse<t.WithdrawalListResponse>> {
        return this.getWithdrawalList(user_id, options);
    }

    /**
     *
     * @param options query options
     * @returns withdrawer detail
     * @description fetch a withdrawal object, related to the user
     */
    async getWithdrawalDetail(
        options: t.WithdrawalDetailOptions
    ): Promise<t.QuidaxResponse<t.WithdrawerDetailResponse>> {
        this.validateUserId(options.user_id, "getWithdrawalDetail");
        try {
            const requestOptions: AxiosRequestConfig<t.WithdrawalListOptions> =
            {
                url: `/users/${options.user_id}/withdraws/${options.withdrawal_id}`,
                method: "GET",
            };
            const resp = await this.mainAxios<
                t.QuidaxResponse<t.WithdrawerDetailResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError(
                    "Failed to get withdrawal detail"
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
     * @deprecated Use getWithdrawalDetail instead.
     */
    async getWithdrawerDetail(
        options: t.WithdrawerDetailOptions
    ): Promise<t.QuidaxResponse<t.WithdrawerDetailResponse>> {
        return this.getWithdrawalDetail(options);
    }

    /**
     *
     * @param options query options
     * @returns withdrawer detail
     * @description fetch a withdrawal object, related to the user by withdrawer reference
     */
    async getWithdrawalByReference(
        options: t.WithdrawerRecordByReferenceOptions
    ): Promise<t.QuidaxResponse<t.WithdrawerRecordByReferenceResponse>> {
        this.validateUserId(options.user_id, "getWithdrawalByReference");
        try {
            const requestOptions: AxiosRequestConfig<t.WithdrawerRecordByReferenceOptions> =
            {
                url: `/users/${options.user_id}/withdraws/reference/${options.reference}`,
                method: "GET",
            };
            const resp = await this.mainAxios<
                t.QuidaxResponse<t.WithdrawerRecordByReferenceResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError("Failed to get withdrawal");
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

    async getWithdrawerByReference(
        options: t.WithdrawerRecordByReferenceOptions
    ): Promise<t.QuidaxResponse<t.WithdrawerRecordByReferenceResponse>> {
        return this.getWithdrawalByReference(options);
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
            const resp = await this.mainAxios<
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
        this.validateUserId(user_id, "buyOrSellOrderRequest");
        try {
            const requestOptions: AxiosRequestConfig<t.SellOrBuyOrderRequestOptions> =
            {
                url: `/users/${user_id}/orders`,
                method: "POST",
                data: options,
            };
            const resp = await this.mainAxios<
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
        this.validateUserId(user_id, "cancelBuyOrSellOrderRequest");
        try {
            const requestOptions: AxiosRequestConfig<t.CancelSellOrBuyOrderRequestOptions> =
            {
                url: `/users/${user_id}/orders/${options.order_id}/cancel`,
                method: "POST",
            };
            const resp = await this.mainAxios<
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
        this.validateUserId(user_id, "getAllOrders");
        try {
            const requestOptions: AxiosRequestConfig<t.GetOrderListOptions> = {
                url: `/users/${user_id}/orders`,
                method: "GET",
                params: options,
            };
            const resp = await this.mainAxios<
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
        this.validateUserId(options.user_id, "getOrderRecord");
        try {
            const requestOptions: AxiosRequestConfig<t.GetOrderRecordOptions> =
            {
                url: `/users/${options.user_id}/orders/${options.order_id}`,
                method: "GET",
            };
            const resp = await this.mainAxios<
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
        this.validateUserId(options.user_id, "instantOrdersRequery");
        try {
            const requestOptions: AxiosRequestConfig = {
                url: `/users/${options.user_id}/instant_orders/${options.instant_order_id}`,
                method: "GET",
            };
            const resp = await this.mainAxios<
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
        this.validateUserId(user_id, "createInstantSwapRequest");
        try {
            const requestOptions: AxiosRequestConfig<t.CreateInstantSwapRequestOptions> =
            {
                url: `/users/${user_id}/swap_quotation`,
                method: "POST",
                data: options,
            };
            const resp = await this.mainAxios<
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
        this.validateUserId(options.user_id, "confirmInstantSwap");
        try {
            const safeUserId = this.encodePathSegment(options.user_id, "user_id");
            const safeQuotationId = this.encodePathSegment(
                options.quotation_id,
                "quotation_id"
            );
            const requestOptions: AxiosRequestConfig<t.ConfirmInstantSwapOptions> =
            {
                url: `/users/${safeUserId}/swap_quotation/${safeQuotationId}/confirm`,
                method: "POST",
            };
            const resp = await this.mainAxios<
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
            // Error handled by handleQuidaxError
            this.handleQuidaxError(error);
        }
    }

    /**
     *
     * @param options query options
     * @returns swap quote
     * @description used to refresh an instant swap quotation.
     */
    async refreshInstantSwapQuote(
        user_id: string,
        quotation_id: string,
        options: t.RefreshInstantSwapOptions
    ): Promise<t.QuidaxResponse<t.RefreshInstantSwapResponse>> {
        this.validateUserId(user_id, "refreshInstantSwapQuote");
        try {
            const safeUserId = this.encodePathSegment(user_id, "user_id");
            const safeQuotationId = this.encodePathSegment(
                quotation_id,
                "quotation_id"
            );
            const requestOptions: AxiosRequestConfig<t.RefreshInstantSwapOptions> =
            {
                url: `/users/${safeUserId}/swap_quotation/${safeQuotationId}/refresh`,
                method: "POST",
                data: options,
            };
            const resp = await this.mainAxios<
                t.QuidaxResponse<t.RefreshInstantSwapResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError("Failed to refresh quote");
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
     * @returns swap transaction
     * @description Fetch an instant swap transaction.
     */
    async getSwapTransaction(
        options: t.GetSwapTransactionOptions
    ): Promise<t.QuidaxResponse<t.GetSwapTransactionResponse>> {
        this.validateUserId(options.user_id, "getSwapTransaction");
        try {
            const requestOptions: AxiosRequestConfig = {
                url: `/users/${options.user_id}/swap_transactions/${options.swap_transaction_id}`,
                method: "GET",
            };
            const resp = await this.mainAxios<
                t.QuidaxResponse<t.GetSwapTransactionResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError(
                    "Failed to get swap transaction"
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
     * @returns swap transaction list
     * @description Get user swap transactions for an authenticated use.
     */
    async getSwapTransactionList(
        user_id: string
    ): Promise<t.QuidaxResponse<t.GetSwapTransactionListResponse>> {
        this.validateUserId(user_id, "getSwapTransactionList");
        try {
            const requestOptions: AxiosRequestConfig = {
                url: `/users/${user_id}/swap_transactions`,
                method: "GET",
            };
            const resp = await this.mainAxios<
                t.QuidaxResponse<t.GetSwapTransactionListResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError(
                    "Failed to get swap transaction list"
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

    /*********************** Deposits ****************************/

    /**
     *
     * @param options query options
     * @returns deposit list
     * @description Fetch all deposits for a user's wallet
     */
    async fetchDeposits(
        options: t.FetchDepositsOptions
    ): Promise<t.QuidaxResponse<t.FetchDepositsResponse>> {
        this.validateUserId(options.user_id, "fetchDeposits");
        try {
            const params: Record<string, any> = {};
            // Currency is a query param, not part of the path
            if (options.currency) params.currency = options.currency;
            if (options.state) params.state = options.state;
            if (options.order_by) params.order_by = options.order_by;

            const requestOptions: AxiosRequestConfig = {
                // Correct endpoint: /users/{user_id}/deposits?currency={currency}
                url: `/users/${options.user_id}/deposits`,
                method: "GET",
                params,
            };
            const resp = await this.mainAxios<
                t.QuidaxResponse<t.FetchDepositsResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError("Failed to fetch deposits");
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
     * @returns deposit detail
     * @description Fetch a single deposit detail by id
     */
    async fetchDeposit(
        options: t.FetchDepositOptions
    ): Promise<t.QuidaxResponse<t.FetchDepositResponse>> {
        this.validateUserId(options.user_id, "fetchDeposit");
        try {
            const requestOptions: AxiosRequestConfig = {
                // Correct endpoint: /users/{user_id}/deposits/{deposit_id}
                url: `/users/${options.user_id}/deposits/${options.deposit_id}`,
                method: "GET",
            };
            const resp = await this.mainAxios<
                t.QuidaxResponse<t.FetchDepositResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError("Failed to fetch deposit");
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

    /*********************** Market *****************************/
    /* 
        The Market API collection enables users to have access to current market-related data such as tickers, 
        k-line (HLOC) data, order book items, and market depth.
    */

    /**
     *
     * @param options query options
     * @returns market list
     * @description Returns a list of all available markets. The sorting of the list is based on
     * Quidax's internal ranking of the markets.
     */
    async getMarketList(): Promise<t.QuidaxResponse<t.GetMarketListResponse>> {
        try {
            const requestOptions: AxiosRequestConfig = {
                url: `/markets`,
                method: "GET",
            };
            const resp = await this.mainAxios<
                t.QuidaxResponse<t.GetMarketListResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError("Failed to get market list");
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
     * @returns market tickers
     * @description Returns the list of tickers(a cryptocurrency buy, sell, volume information)
     * for all available markets.
     */
    async getMarketTickers(): Promise<
        t.QuidaxResponse<t.GetMarketTickersResponse>
    > {
        try {
            const requestOptions: AxiosRequestConfig = {
                url: `/markets/tickers`,
                method: "GET",
            };
            const resp = await this.mainAxios<
                t.QuidaxResponse<t.GetMarketTickersResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError("Failed to get market tickers");
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
     * @returns market ticker
     * @description Returns the market ticker for a specific market.
     */
    async getSingleMarketTicker(
        currency: string
    ): Promise<t.QuidaxResponse<t.GetMarketTickerResponse>> {
        try {
            const requestOptions: AxiosRequestConfig = {
                url: `/markets/tickers/${currency}`,
                method: "GET",
            };
            const resp = await this.mainAxios<
                t.QuidaxResponse<t.GetMarketTickerResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError("Failed to get market ticker");
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
     * @returns order book
     * @description Gets the volume of trades that are currently being processed by the order book.
     */
    async getOrderBookItemsForAMarket(
        options: t.GetOrderBookItemsForAMarketOptions
    ): Promise<t.QuidaxResponse<t.GetOrderBookItemsForAMarketResponse>> {
        try {
            const requestOptions: AxiosRequestConfig<t.GetOrderBookItemsForAMarketOptions> =
            {
                url: `/markets/${options.currency}/order_book`,
                method: "GET",
                params: {
                    ask_limit: options.ask_limit,
                    bids_limit: options.bids_limit,
                },
            };
            const resp = await this.mainAxios<
                t.QuidaxResponse<t.GetOrderBookItemsForAMarketResponse>
            >(requestOptions);

            if (!resp.data) {
                const error = new e.QuidaxError("Failed to get order book");
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

    /*************************** RAMP ***********************************************/

    /**
     *
     * @param options query options
     * @returns payment methods
     * @description get payment methods list
     */
    async getPaymentMethods(
        options: t.PaymentMethodsOptions
    ): Promise<t.QuidaxResponse<any>> {
        try {
            const requestOptions: AxiosRequestConfig<t.PaymentMethodsOptions> =
            {
                url: `/payment_methods`,
                method: "GET",
                params: options,
            };
            const resp = await this.rampAxios<t.QuidaxResponse<any>>(
                requestOptions
            );

            if (!resp.data) {
                const error = new e.QuidaxError(
                    "Failed to get payment methods"
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
     * @returns purchase buy limit
     * @description Retrieves the minimum and maximum allowed purchase amounts for fiat currency transactions.
     */
    async getPurchaseLimitForBuy(
        options: t.PurchaseLimitBuyOptions
    ): Promise<t.QuidaxResponse<any>> {
        try {
            const requestOptions: AxiosRequestConfig<t.PurchaseLimitBuyOptions> =
            {
                url: `/purchase_limits/buy`,
                method: "GET",
                params: options,
            };
            const resp = await this.rampAxios<t.QuidaxResponse<any>>(
                requestOptions
            );

            if (!resp.data) {
                const error = new e.QuidaxError("Failed to get purchase limit");
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
     * @returns sell limit
     * @description Retrieves the minimum and maximum allowed sell amounts for cryptocurrency transactions.
     */
    async getPurchaseLimitForSell(
        options: t.PurchaseLimitSellOptions
    ): Promise<t.QuidaxResponse<any>> {
        try {
            const requestOptions: AxiosRequestConfig<t.PurchaseLimitSellOptions> =
            {
                url: `/purchase_limits/sell`,
                method: "GET",
                params: options,
            };
            const resp = await this.rampAxios<t.QuidaxResponse<any>>(
                requestOptions
            );

            if (!resp.data) {
                const error = new e.QuidaxError("Failed to get purchase limit");
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
     * @returns buy quote
     * @description Retrieves real-time exchange quotes between a fiat currency and a cryptocurrency, including estimated fiat processing fees.
     */
    async getPurchaseQuoteForBuy(
        options: t.PurchaseQuoteBuyOptions
    ): Promise<t.QuidaxResponse<any>> {
        try {
            const requestOptions: AxiosRequestConfig<t.PurchaseQuoteBuyOptions> =
            {
                url: `/purchase_quotes/buy`,
                method: "GET",
                params: options,
            };
            const resp = await this.rampAxios<t.QuidaxResponse<any>>(
                requestOptions
            );

            if (!resp.data) {
                const error = new e.QuidaxError("Failed to get purchase quote");
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
     * @returns sell quote
     * @description Retrieves real-time exchange quotes between a fiat currency and a cryptocurrency, including estimated blockchain processing fees.
     */
    async getPurchaseQuoteForSell(
        options: t.PurchaseQuoteSellOptions
    ): Promise<t.QuidaxResponse<any>> {
        try {
            const requestOptions: AxiosRequestConfig<t.PurchaseQuoteSellOptions> =
            {
                url: `/purchase_quotes/sell`,
                method: "GET",
                params: options,
            };
            const resp = await this.rampAxios<t.QuidaxResponse<any>>(
                requestOptions
            );

            if (!resp.data) {
                const error = new e.QuidaxError("Failed to get purchase quote");
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
