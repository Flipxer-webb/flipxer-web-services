import Axios, { AxiosInstance, AxiosRequestConfig, AxiosError } from "axios";

export interface FincraOptions {
    baseUrl: string;
    secretKey: string;
    publicKey: string;
    businessId?: string;
    webhookSecret?: string;
}

export interface FincraPayInPayload {
    amount: number;
    currency: string; // e.g. NGN
    reference: string;
    redirectUrl?: string;
    feeBearer?: "business" | "customer";
    paymentMethods?: string[];
    customer: {
        name: string;
        email: string;
        phoneNumber?: string;
    };
    metadata?: Record<string, unknown>;
}

export interface FincraPayInResponseData {
    link: string;
    reference: string;
    payCode: string;
}

export interface FincraPayInResponse {
    status: boolean;
    message: string;
    data: FincraPayInResponseData;
}

export interface FincraVerifyResponse {
    status: boolean;
    message: string;
    data: {
        status: string; // success, pending, failed
        reference: string;
        merchantReference?: string;
        amount: number;
        currency: string;
        amountReceived?: number;
        fee?: number;
    };
}

// Bank List Types
export interface FincraBank {
    name: string;
    code: string;
    country: string;
}

export interface FincraBankListResponse {
    success: boolean;
    message: string;
    data: FincraBank[];
}

// Account Resolve Types
export interface FincraResolveAccountPayload {
    accountNumber: string;
    bankCode: string;
    currency?: string; // defaults to NGN
    type?: "bank_account" | "nuban" | "iban";
}

export interface FincraResolveAccountResponse {
    success: boolean;
    message: string;
    data: {
        accountNumber: string;
        accountName: string;
        bankCode: string;
    };
}

// Payout (Bank Transfer) Types
export interface FincraBeneficiary {
    firstName: string;
    lastName: string;
    accountHolderName: string;
    accountNumber: string;
    bankCode: string;
    type: "individual" | "corporate";
    country?: string;
    email?: string;
    phone?: string;
}

export interface FincraPayoutPayload {
    amount: number;
    business: string; // Business ID
    sourceCurrency: string;
    destinationCurrency: string;
    description: string;
    paymentDestination: "bank_account" | "mobile_money";
    customerReference: string;
    beneficiary: FincraBeneficiary;
    quoteReference?: string; // Required for cross-currency
    sender?: {
        name: string;
        email: string;
    };
}

export interface FincraPayoutResponse {
    success: boolean;
    message: string;
    data: {
        id: string;
        reference: string;
        status: string;
        amount: number;
        fee: number;
        currency: string;
    };
}

export interface FincraPayoutStatusResponse {
    success: boolean;
    message: string;
    data: {
        id: string;
        reference: string;
        customerReference: string;
        status: string; // processing, successful, failed, pending
        amount: number;
        fee: number;
        currency: string;
    };
}

export class FincraLib {
    private axios: AxiosInstance;

    constructor(private readonly options: FincraOptions) {
        this.axios = Axios.create({
            baseURL: options.baseUrl,
            headers: {
                "api-key": options.secretKey,
                "x-pub-key": options.publicKey,
                "Content-Type": "application/json",
            },
        });
    }

    private handleError(error: AxiosError<any>) {
        if (!Axios.isAxiosError(error)) {
            throw error;
        }
        const message = error.response?.data?.message || error.message;
        const err = new Error(message);
        (err as any).status = error.response?.status;
        throw err;
    }

    async initializeCheckout(payload: FincraPayInPayload) {
        try {
            const requestOptions: AxiosRequestConfig<FincraPayInPayload> = {
                method: "POST",
                url: "/checkout/payments",
                data: payload,
            };
            const { data } = await this.axios<FincraPayInResponse>(
                requestOptions
            );
            return data;
        } catch (error) {
            this.handleError(error as AxiosError);
        }
    }

    async verifyPayment(reference: string) {
        try {
            const requestOptions: AxiosRequestConfig = {
                method: "GET",
                url: `/checkout/payments/merchant-reference/${reference}`,
                headers: this.options.businessId
                    ? { "x-business-id": this.options.businessId }
                    : undefined,
            };
            const { data } = await this.axios<FincraVerifyResponse>(
                requestOptions
            );
            return data;
        } catch (error) {
            this.handleError(error as AxiosError);
        }
    }

    /**
     * Get list of banks for a specific country
     * @param countryCode - ISO 3166-1 alpha-2 country code (e.g., "NG" for Nigeria)
     */
    async getBanks(countryCode: string = "NG") {
        try {
            const requestOptions: AxiosRequestConfig = {
                method: "GET",
                url: `/core/banks`,
                params: { currency: countryCode === "NG" ? "NGN" : countryCode },
            };
            const { data } = await this.axios<FincraBankListResponse>(
                requestOptions
            );
            return data;
        } catch (error) {
            this.handleError(error as AxiosError);
        }
    }

    /**
     * Resolve/verify a bank account number
     */
    async resolveBankAccount(payload: FincraResolveAccountPayload): Promise<FincraResolveAccountResponse> {
        try {
            const requestData = {
                ...payload,
                currency: payload.currency || "NGN",
                // Use "nuban" for Nigerian bank accounts (NUBAN = Nigerian Uniform Bank Account Number)
                type: payload.type || "nuban",
            };
            console.log("****FINCRA RESOLVE REQUEST PAYLOAD****", JSON.stringify(requestData));
            console.log("****FINCRA BASE URL****", this.options.baseUrl);
            
            const requestOptions: AxiosRequestConfig<FincraResolveAccountPayload> = {
                method: "POST",
                url: "/core/accounts/resolve",
                data: requestData,
            };
            const { data } = await this.axios<FincraResolveAccountResponse>(
                requestOptions
            );
            return data;
        } catch (error) {
            console.log("****FINCRA RESOLVE ERROR****", error);
            this.handleError(error as AxiosError);
            throw error; // This ensures TypeScript knows we always throw
        }
    }

    /**
     * Initiate a bank transfer payout
     */
    async initiateBankTransfer(payload: FincraPayoutPayload) {
        try {
            const requestOptions: AxiosRequestConfig<FincraPayoutPayload> = {
                method: "POST",
                url: "/disbursements/payouts",
                data: {
                    ...payload,
                    business: payload.business || this.options.businessId,
                },
            };
            const { data } = await this.axios<FincraPayoutResponse>(
                requestOptions
            );
            return data;
        } catch (error) {
            this.handleError(error as AxiosError);
        }
    }

    /**
     * Verify payout status by reference
     */
    async verifyPayoutByReference(reference: string) {
        try {
            const requestOptions: AxiosRequestConfig = {
                method: "GET",
                url: `/disbursements/payouts/${reference}`,
            };
            const { data } = await this.axios<FincraPayoutStatusResponse>(
                requestOptions
            );
            return data;
        } catch (error) {
            this.handleError(error as AxiosError);
        }
    }

    /**
     * Verify payout status by customer reference
     */
    async verifyPayoutByCustomerReference(customerReference: string) {
        try {
            const requestOptions: AxiosRequestConfig = {
                method: "GET",
                url: `/disbursements/payouts/customer-reference/${customerReference}`,
            };
            const { data } = await this.axios<FincraPayoutStatusResponse>(
                requestOptions
            );
            return data;
        } catch (error) {
            this.handleError(error as AxiosError);
        }
    }
}
