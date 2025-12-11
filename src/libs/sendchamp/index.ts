import axios, { AxiosInstance, AxiosError } from "axios";
import * as t from "./types";
import * as e from "./errors";

export * from "./types";
export * from "./errors";

export class SendchampLib {
    private readonly axios: AxiosInstance;

    constructor(options: t.SendchampOptions) {
        if (!options.accessKey) {
            throw new e.SendchampAuthorizationError(
                "Sendchamp access key is required"
            );
        }

        this.axios = axios.create({
            baseURL: options.baseUrl || "https://api.sendchamp.com/api/v1",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                Authorization: `Bearer ${options.accessKey}`,
            },
            timeout: 30000,
        });
    }

    /**
     * Send SMS to one or more recipients
     */
    async sendSms(request: t.SendSmsRequest): Promise<t.SendSmsResponse> {
        try {
            const payload = {
                to: Array.isArray(request.to) ? request.to : [request.to],
                message: request.message,
                sender_name: request.sender_name,
                route: request.route || "non_dnd",
            };

            const response = await this.axios.post<t.SendSmsResponse>(
                "/sms/send",
                payload
            );

            return response.data;
        } catch (error) {
            this.handleError(error);
        }
    }

    /**
     * Handle API errors and throw appropriate exceptions
     */
    private handleError(error: unknown): never {
        if (axios.isAxiosError(error)) {
            const axiosError = error as AxiosError<t.SendchampApiError>;
            const status = axiosError.response?.status;
            const message =
                axiosError.response?.data?.message ||
                axiosError.message ||
                "Unknown error";

            switch (status) {
                case 401:
                    throw new e.SendchampAuthorizationError(message);
                case 402:
                    throw new e.SendchampInsufficientBalanceError(message);
                case 422:
                    throw new e.SendchampValidationError(message);
                default:
                    throw new e.SendchampGenericError(message);
            }
        }

        throw new e.SendchampGenericError(
            error instanceof Error ? error.message : "Unknown error"
        );
    }
}
