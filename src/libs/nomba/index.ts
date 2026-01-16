import Axios, { AxiosInstance, AxiosError } from "axios";

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
    data: {
        access_token: string;
        refresh_token: string;
        token_type: string;
        expires_in: number;
    };
}

// Bank types
export interface NombaBank {
    bankCode: string;
    bankName: string;
}

export interface NombaBankListResponse {
    code: string;
    description: string;
    data: {
        results: NombaBank[];
        cursor: string | null;
    };
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
    expiryDate?: string; // ISO date for dynamic accounts
}

export interface NombaVirtualAccountResponse {
    code: string;
    description: string;
    data: {
        accountRef: string;
        accountNumber: string;
        accountName: string;
        bankName: string;
        bankCode: string;
        currency: string;
        status: string;
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
        reference: string;
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

interface TokenCache {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
}

export class NombaLib {
    private axios: AxiosInstance;
    private tokenCache: TokenCache | null = null;

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
     * Get a valid access token, refreshing if needed
     */
    private async getValidToken(): Promise<string | null> {
        // Check if we have a valid cached token
        if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60000) {
            return this.tokenCache.accessToken;
        }

        // Try to refresh if we have a refresh token
        if (this.tokenCache?.refreshToken) {
            try {
                await this.refreshAccessToken(this.tokenCache.refreshToken);
                return this.tokenCache?.accessToken || null;
            } catch {
                // Refresh failed, get new token
            }
        }

        // Get new token
        await this.obtainAccessToken();
        return this.tokenCache?.accessToken || null;
    }

    /**
     * Obtain initial access token using client credentials
     */
    async obtainAccessToken(): Promise<NombaTokenResponse> {
        try {
            const { data } = await this.axios.post<NombaTokenResponse>(
                "/v2/auth/token/issue",
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
                    expiresAt: Date.now() + data.data.expires_in * 1000,
                };
            }

            return data;
        } catch (error) {
            this.handleError(error as AxiosError);
            throw error;
        }
    }

    /**
     * Refresh an expired access token
     */
    async refreshAccessToken(refreshToken: string): Promise<NombaTokenResponse> {
        try {
            const { data } = await this.axios.post<NombaTokenResponse>(
                "/v2/auth/token/refresh",
                {
                    grant_type: "refresh_token",
                    refresh_token: refreshToken,
                }
            );

            if (data.code === "00" && data.data) {
                this.tokenCache = {
                    accessToken: data.data.access_token,
                    refreshToken: data.data.refresh_token,
                    expiresAt: Date.now() + data.data.expires_in * 1000,
                };
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
        try {
            const { data } = await this.axios.get<NombaBankListResponse>(
                "/v2/transfers/banks"
            );
            return data;
        } catch (error) {
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
                "/v2/transfers/bank/account/lookup",
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
                "/v2/accounts/virtual",
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
                `/v2/accounts/virtual/${accountRef}`
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
    async createCheckoutOrder(
        payload: NombaCheckoutOrderPayload
    ): Promise<NombaCheckoutOrderResponse> {
        try {
            const { data } = await this.axios.post<NombaCheckoutOrderResponse>(
                "/v2/checkout/order",
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
            const { data } = await this.axios.get<NombaCheckoutStatusResponse>(
                `/v2/checkout/order/${orderReference}`
            );
            return data;
        } catch (error) {
            this.handleError(error as AxiosError);
            throw error;
        }
    }
}
