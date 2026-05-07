import Axios, { AxiosInstance, AxiosError } from "axios";
import { Mutex } from "async-mutex";
import { Logger } from "@nestjs/common";

export interface NombaOptions {
    baseUrl: string;
    clientId: string;
    clientSecret: string;
    accountId: string;
    webhookSecret?: string;
}

// Token types
export interface NombaTokenResponse {
    code: string;
    description: string;
    status?: boolean;
    data: {
        access_token: string;
        refresh_token: string;
        businessId?: string;
        expiresAt: string; // ISO date string from Nomba API
    };
}

// Bank types - actual Nomba response has name/code, not bankName/bankCode
export interface NombaBank {
    name: string;
    code: string;
    nipCode: string | null;
    logo: string;
}

// Actual Nomba response: data is array directly, not { results: [] }
export interface NombaBankListResponse {
    code: string;
    description: string;
    message?: string;
    status?: boolean;
    data: NombaBank[];  // Direct array, not nested results
}

// Account lookup types
export interface NombaAccountLookupPayload {
    accountNumber: string;
    bankCode: string;
}

export interface NombaAccountLookupResponse {
    code: string;
    description: string;
    data: {
        accountNumber: string;
        accountName: string;
        bankCode: string;
    };
}

// Virtual account types
export interface NombaVirtualAccountPayload {
    accountRef: string;
    accountName: string;
    currency?: string;
    expiryDate?: string; // e.g. "2024-06-17 04:55:00"
    expectedAmount?: number;
    bvn?: string;
}

export interface NombaVirtualAccountResponse {
    code: string;
    description: string;
    data: {
        createdAt: string;
        accountHolderId: string;
        accountRef: string;
        bvn?: string;
        accountName: string;          // name we set
        currency: string;
        bankName: string;             // e.g. "Nombank MFB"
        bankAccountNumber: string;    // the actual VA number
        bankAccountName: string;      // bank-assigned name
        callbackUrl?: string;
        expired: boolean;
    };
}

// Transfer types
export interface NombaBankTransferPayload {
    amount: number;
    accountNumber: string;
    accountName: string;
    bankCode: string;
    merchantTxRef: string;
    narration?: string;
    senderName?: string;
    pin?: string;
}

export interface NombaBankTransferResponse {
    code: string;
    description: string;
    data: {
        id: string;
        amount: number;
        fee: number;
        status: string;
        merchantTxRef: string;
        reference?: string;
        meta?: {
            merchantTxRef?: string;
        };
    };
}

export interface NombaTransferStatusResponse {
    code: string;
    description: string;
    data: {
        id: string;
        amount: number;
        fee: number;
        status: string; // SUCCESS, FAILED, PENDING
        merchantTxRef: string;
        reference: string;
        createdAt: string;
    };
}

// Checkout order types
export interface NombaCheckoutOrderPayload {
    order: {
        orderReference: string;
        customerId: string;
        customerEmail?: string;
        amount: number;
        currency?: string; // Defaults to NGN
        callbackUrl?: string;
    };
    tokenizeCard?: boolean;
}

export interface NombaCheckoutOrderResponse {
    code: string;
    description: string;
    data: {
        orderReference: string;
        checkoutLink: string;
        amount: number;
        currency: string;
        status: string;
        expiresAt?: string;
    };
}

export interface NombaCheckoutStatusResponse {
    code: string;
    description: string;
    data: {
        orderReference: string;
        amount: number;
        currency: string;
        status: string; // PENDING, COMPLETED, FAILED, EXPIRED
        paymentMethod?: string;
        paidAt?: string;
    };
}

// Account balance types
export interface NombaAccountBalanceResponse {
    code: string;
    description: string;
    data: {
        amount: string;
        currency: string;
        timeCreated: string;
    };
}

interface TokenCache {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
}

export class NombaLib {
    private readonly axios: AxiosInstance;
    private tokenCache: TokenCache | null = null;
    private readonly tokenMutex = new Mutex();
    private readonly logger = new Logger('NombaLib');

    /**
     * Returns true when the configured base URL points to the Nomba sandbox.
     */
    get isSandbox(): boolean {
        return this.options.baseUrl.includes("sandbox");
    }

    constructor(private readonly options: NombaOptions) {
        this.axios = Axios.create({
            baseURL: options.baseUrl,
            headers: {
                "Content-Type": "application/json",
                accountId: options.accountId,
            },
        });

        // Add request interceptor to attach auth token
        this.axios.interceptors.request.use(async (config) => {
            // Skip auth for token endpoints
            if (config.url?.includes("/auth/token")) {
                return config;
            }

            const token = await this.getValidToken();
            if (token) {
                config.headers.Authorization = `Bearer ${token}`;
            }
            return config;
        });

        // Add request logging interceptor
        this.axios.interceptors.request.use(
            (config) => {
                this.logger.debug(`[REQUEST] ${config.method?.toUpperCase()} ${config.baseURL}${config.url}`);
                this.logger.debug(`[REQUEST] Headers: ${JSON.stringify({
                    accountId: config.headers.accountId,
                    Authorization: config.headers.Authorization ? 'Bearer ***' : 'NONE',
                    'Content-Type': config.headers['Content-Type'],
                })}`);
                if (config.data) {
                    this.logger.debug(`[REQUEST] Body: ${JSON.stringify(this.sanitizeNombaPayload(config.data))}`);
                }
                return config;
            },
            (error) => {
                this.logger.error(`[REQUEST ERROR] ${error.message}`);
                return Promise.reject(error);
            }
        );

        // Add response logging interceptor
        this.axios.interceptors.response.use(
            (response) => {
                this.logger.debug(`[RESPONSE] ${response.status} ${response.config.url}`);
                this.logger.debug(`[RESPONSE] Data: ${JSON.stringify(this.sanitizeNombaPayload(response.data))}`);
                return response;
            },
            (error) => {
                this.logger.error(`[RESPONSE ERROR] ${error.response?.status || 'NO STATUS'} ${error.config?.url}`);
                this.logger.error(`[RESPONSE ERROR] Data: ${JSON.stringify(this.sanitizeNombaPayload(error.response?.data || error.message))}`);
                return Promise.reject(error);
            }
        );
    }

    private sanitizeNombaPayload(payload: unknown): unknown {
        if (!payload || typeof payload !== "object") {
            return payload;
        }

        try {
            const copy: any = structuredClone(payload);

            if (copy?.client_secret) {
                copy.client_secret = "[REDACTED]";
            }
            if (copy?.data?.access_token) {
                copy.data.access_token = "[REDACTED]";
            }
            if (copy?.data?.refresh_token) {
                copy.data.refresh_token = "[REDACTED]";
            }

            return copy;
        } catch {
            return "[UNSERIALIZABLE_PAYLOAD]";
        }
    }

    private resolveTokenExpiry(expiresAt: string): number {
        const expiresAtMs = new Date(expiresAt).getTime();
        if (!Number.isFinite(expiresAtMs)) {
            const fallbackExpiryMs = Date.now() + 55 * 60 * 1000;
            this.logger.warn(`Invalid token expiry received from Nomba: ${expiresAt}. Using fallback expiry.`);
            return fallbackExpiryMs;
        }

        return expiresAtMs;
    }

    private handleError(error: AxiosError<any>) {
        if (!Axios.isAxiosError(error)) {
            throw error;
        }
        const message =
            error.response?.data?.description ||
            error.response?.data?.message ||
            error.message;
        const err = new Error(message);
        (err as any).status = error.response?.status;
        (err as any).code = error.response?.data?.code;
        throw err;
    }

    /**
     * Get a valid access token, refreshing if needed.
     * Uses a mutex to prevent concurrent token refresh/issue thundering herd.
     */
    private async getValidToken(): Promise<string | null> {
        return this.tokenMutex.runExclusive(async () => {
            // Double-check after acquiring mutex (another caller may have refreshed)
            if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60000) {
                return this.tokenCache.accessToken;
            }

            // Try to refresh if we have a refresh token
            if (this.tokenCache?.refreshToken) {
                try {
                    await this.refreshAccessToken(this.tokenCache.refreshToken);
                    return this.tokenCache?.accessToken || null;
                } catch (err) {
                    this.logger.warn(`Token refresh failed, falling back to fresh token issue: ${(err as Error).message}`);
                    this.tokenCache = null; // Clear stale cache to prevent retries with same token
                }
            }

            // Get new token
            await this.obtainAccessToken();
            return this.tokenCache?.accessToken || null;
        });
    }

    /**
     * Obtain initial access token using client credentials
     */
    private async obtainAccessToken(): Promise<NombaTokenResponse> {
        try {
            const { data } = await this.axios.post<NombaTokenResponse>(
                "/v1/auth/token/issue",
                {
                    grant_type: "client_credentials",
                    client_id: this.options.clientId,
                    client_secret: this.options.clientSecret,
                }
            );

            if (data.code === "00" && data.data) {
                this.tokenCache = {
                    accessToken: data.data.access_token,
                    refreshToken: data.data.refresh_token,
                    expiresAt: this.resolveTokenExpiry(data.data.expiresAt),
                };
                this.logger.log(`Token issued, expires at ${data.data.expiresAt}`);
            }

            return data;
        } catch (error) {
            this.handleError(error as AxiosError);
            throw error;
        }
    }

    /**
     * Refresh an access token nearing expiry
     * NOTE: Nomba requires the current (still-valid) access token in the Authorization header
     */
    private async refreshAccessToken(refreshToken: string): Promise<NombaTokenResponse> {
        try {
            // Nomba requires current access token even when refreshing
            const currentToken = this.tokenCache?.accessToken;

            const { data } = await this.axios.post<NombaTokenResponse>(
                "/v1/auth/token/refresh",
                {
                    grant_type: "refresh_token",
                    refresh_token: refreshToken,
                },
                currentToken ? {
                    headers: {
                        Authorization: `Bearer ${currentToken}`,
                    },
                } : undefined
            );

            if (data.code === "00" && data.data) {
                this.tokenCache = {
                    accessToken: data.data.access_token,
                    refreshToken: data.data.refresh_token,
                    expiresAt: this.resolveTokenExpiry(data.data.expiresAt),
                };
                this.logger.log(`Token refreshed, expires at ${data.data.expiresAt}`);
            }

            return data;
        } catch (error) {
            this.handleError(error as AxiosError);
            throw error;
        }
    }

    /**
     * Get list of Nigerian banks
     */
    async getBanks(): Promise<NombaBankListResponse> {
        this.logger.debug("Starting bank list fetch...");
        try {
            // Nomba API: GET /v1/transfers/banks (plural, v1)
            const { data } = await this.axios.get<NombaBankListResponse>(
                "/v1/transfers/banks"
            );

            // Detailed logging to debug empty bank list issue
            this.logger.debug(`Bank list response: ${JSON.stringify({
                code: data?.code,
                description: data?.description,
                banksCount: data?.data?.length || 0,
                sampleBanks: data?.data?.slice(0, 3).map(b => ({ code: b.code, name: b.name })) || [],
            })}`);

            if (!data?.data || data.data.length === 0) {
                this.logger.warn(`Empty bank list returned: ${JSON.stringify(data)}`);
            }

            return data;
        } catch (error) {
            this.logger.error(`Error fetching bank list: ${JSON.stringify({
                message: error.message,
                response: error.response?.data,
                status: error.response?.status,
            })}`);
            this.handleError(error as AxiosError);
            throw error;
        }
    }

    /**
     * Lookup/resolve bank account details
     */
    async lookupBankAccount(
        payload: NombaAccountLookupPayload
    ): Promise<NombaAccountLookupResponse> {
        try {
            const { data } = await this.axios.post<NombaAccountLookupResponse>(
                "/v1/transfers/bank/lookup",
                payload
            );
            return data;
        } catch (error) {
            this.handleError(error as AxiosError);
            throw error;
        }
    }

    /**
     * Create a virtual account for receiving payments
     */
    async createVirtualAccount(
        payload: NombaVirtualAccountPayload
    ): Promise<NombaVirtualAccountResponse> {
        try {
            const { data } = await this.axios.post<NombaVirtualAccountResponse>(
                "/v1/accounts/virtual",
                {
                    ...payload,
                    currency: payload.currency || "NGN",
                }
            );
            return data;
        } catch (error) {
            this.handleError(error as AxiosError);
            throw error;
        }
    }

    /**
     * Get virtual account details
     */
    async getVirtualAccount(accountRef: string): Promise<NombaVirtualAccountResponse> {
        try {
            const { data } = await this.axios.get<NombaVirtualAccountResponse>(
                `/v1/accounts/virtual/${accountRef}`
            );
            return data;
        } catch (error) {
            this.handleError(error as AxiosError);
            throw error;
        }
    }

    /**
     * Delete a virtual account by its accountRef.
     * Returns true if deleted successfully, false if already gone (404).
     */
    async deleteVirtualAccount(accountRef: string): Promise<boolean> {
        try {
            const { data } = await this.axios.delete<{ code: string; status: boolean }>(
                `/v1/accounts/virtual/${accountRef}`
            );
            return data?.code === "00";
        } catch (error) {
            const axiosError = error as AxiosError;
            if (axiosError.response?.status === 404) {
                return false;
            }
            this.handleError(axiosError);
            throw error;
        }
    }

    /**
     * Update an existing virtual account (e.g. refresh its expiry).
     * Used as a sandbox fallback when the VA creation quota is exhausted.
     */
    async updateVirtualAccount(
        accountRef: string,
        updates: { accountName?: string; expiryDate?: string },
    ): Promise<NombaVirtualAccountResponse> {
        try {
            const { data } = await this.axios.put<NombaVirtualAccountResponse>(
                `/v1/accounts/virtual/${accountRef}`,
                updates,
            );
            return data;
        } catch (error) {
            this.handleError(error as AxiosError);
            throw error;
        }
    }

    /**
     * Initiate bank transfer (payout)
     */
    async initiateBankTransfer(
        payload: NombaBankTransferPayload
    ): Promise<NombaBankTransferResponse> {
        try {
            const { data } = await this.axios.post<NombaBankTransferResponse>(
                "/v2/transfers/bank",
                payload
            );
            return data;
        } catch (error) {
            this.handleError(error as AxiosError);
            throw error;
        }
    }

    /**
     * Get transfer status by ID
     */
    async getTransferStatus(transferId: string): Promise<NombaTransferStatusResponse> {
        try {
            const { data } = await this.axios.get<NombaTransferStatusResponse>(
                `/v2/transfers/${transferId}`
            );
            return data;
        } catch (error) {
            this.handleError(error as AxiosError);
            throw error;
        }
    }

    /**
     * Get transfer status by merchant reference
     */
    async getTransferByMerchantRef(
        merchantTxRef: string
    ): Promise<NombaTransferStatusResponse> {
        try {
            const { data } = await this.axios.get<NombaTransferStatusResponse>(
                `/v2/transfers/merchant-ref/${merchantTxRef}`
            );
            return data;
        } catch (error) {
            this.handleError(error as AxiosError);
            throw error;
        }
    }

    /**
     * Create a checkout order for payment collection
     * Returns a checkout link that can be displayed to the customer
     */
    /**
     * Create a checkout order for payment collection
     * Returns a checkout link that can be displayed to the customer
     */
    async createCheckoutOrder(
        payload: NombaCheckoutOrderPayload
    ): Promise<NombaCheckoutOrderResponse> {
        try {
            const { data } = await this.axios.post<NombaCheckoutOrderResponse>(
                "/v1/checkout/order",
                {
                    order: {
                        ...payload.order,
                        currency: payload.order.currency || "NGN",
                    },
                    tokenizeCard: payload.tokenizeCard || false,
                }
            );
            return data;
        } catch (error) {
            this.handleError(error as AxiosError);
            throw error;
        }
    }

    /**
     * Get checkout order status by order reference
     */
    async getCheckoutStatus(
        orderReference: string
    ): Promise<NombaCheckoutStatusResponse> {
        try {
            // V1 uses /checkout/transaction with query param for reference
            const { data } = await this.axios.get<NombaCheckoutStatusResponse>(
                `/v1/checkout/transaction`,
                {
                    params: {
                        idType: "ORDER_REFERENCE",
                        id: orderReference
                    }
                }
            );
            return data;
        } catch (error) {
            this.handleError(error as AxiosError);
            throw error;
        }
    }

    /**
     * Get parent account balance
     */
    async getAccountBalance(): Promise<NombaAccountBalanceResponse> {
        try {
            const { data } = await this.axios.get<NombaAccountBalanceResponse>(
                `/v1/accounts/balance`
            );
            return data;
        } catch (error) {
            this.handleError(error as AxiosError);
            throw error;
        }
    }
}
