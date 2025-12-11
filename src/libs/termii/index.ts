import Axios, { AxiosError, AxiosInstance } from "axios";
import {
    TermiiAuthorizationError,
    TermiiGenericError,
    TermiiInsufficientBalanceError,
    TermiiValidationError,
} from "./errors";
import {
    TermiiOptions,
    TermiiResponse,
    SendSmsOptions,
    SendSmsResponse,
    BalanceResponse,
} from "./types";

export * from "./errors";
export * from "./types";

export class TermiiLib {
    private axios: AxiosInstance;
    private apiKey: string;

    constructor(protected instanceOptions: TermiiOptions) {
        this.apiKey = instanceOptions.apiKey;
        this.axios = Axios.create({
            baseURL: instanceOptions.baseUrl || "https://v3.api.termii.com",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
            },
        });
    }

    private handleTermiiError(error: AxiosError<any>) {
        const status = error.response?.status;
        const message = error.response?.data?.message || error.message;

        switch (status) {
            case 401:
                throw new TermiiAuthorizationError(message);
            case 400:
                throw new TermiiValidationError(message);
            case 402:
                throw new TermiiInsufficientBalanceError(message);
            default: {
                const err = new TermiiGenericError(message);
                err.status = status;
                throw err;
            }
        }
    }

    /**
     * Send SMS to a recipient
     * @param options SMS options
     * @returns SMS response data
     */
    async sendSms(options: SendSmsOptions): Promise<TermiiResponse<SendSmsResponse>> {
        try {
            const response = await this.axios.post<TermiiResponse<SendSmsResponse>>(
                "/api/sms/send",
                {
                    api_key: this.apiKey,
                    to: options.to,
                    from: options.from,
                    sms: options.sms,
                    type: options.type || "plain",
                    channel: options.channel || "generic",
                }
            );

            return response.data;
        } catch (error) {
            this.handleTermiiError(error as AxiosError);
            throw error;
        }
    }

    /**
     * Get account balance
     * @returns Balance information
     */
    async getBalance(): Promise<BalanceResponse> {
        try {
            const response = await this.axios.get<BalanceResponse>(
                `/api/get-balance?api_key=${this.apiKey}`
            );
            return response.data;
        } catch (error) {
            this.handleTermiiError(error as AxiosError);
            throw error;
        }
    }
}
