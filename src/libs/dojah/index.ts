import * as e from "./errors";
import Axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from "axios";
export * from "./errors";
export * from "./types";
import * as t from "./types";

export class DojahLib {
    constructor(protected instanceOptions: t.DojahOptions) {}

    private axios: AxiosInstance = Axios.create({
        baseURL: this.instanceOptions.baseURL,
        headers: {
            Authorization: this.instanceOptions.apiKey,
            AppId: this.instanceOptions.appId,
        },
    });

    private handleDojahError(error: AxiosError<any>) {
        switch (true) {
            case error.response?.status == 401: {
                throw new e.DojahAuthorizationError(error.response.data.error);
            }
            case error.response?.status == 400: {
                throw new e.DojahValidationError(error.response.data.error);
            }

            case error.response?.status == 402: {
                throw new e.DojahLowBalanceError(error.response.data.error);
            }

            case error.response?.status == 404: {
                throw new e.DojahNotFoundError(error.response.data.error);
            }

            case error.response?.status == 405: {
                throw new e.DojahMethodNotFoundError(error.response.data.error);
            }

            case error.response?.status == 408: {
                throw new e.DojahRequestTimeoutError(error.response.data.error);
            }

            case error.response?.status == 424: {
                throw new e.DojahThirdPartyServiceFailureError(
                    error.response.data.error
                );
            }

            case error.response?.status == 429: {
                throw new e.DojahTooManyRequestError(error.response.data.error);
            }

            default: {
                const err = new e.DojahGenericError(
                    error.response?.data?.error || error.response?.statusText
                );
                err.status = error.response?.status;
                throw err;
            }
        }
    }

    async verifyBvn(
        options: t.VerifyBvnOptions
    ): Promise<t.DojahResponse<t.VerifyBvnResponseData>> {
        try {
            const requestOptions: AxiosRequestConfig = {
                url: "/api/v1/kyc/bvn/full",
                method: "GET",
                params: {
                    bvn: options.bvn,
                    first_name: options.first_name,
                    last_name: options.last_name,
                    dob: options.dob,
                } as t.VerifyBvnOptions,
            };
            const resp = await this.axios<t.VerifyBvnResponseData>(
                requestOptions
            );

            if (!resp.data) {
                const error = new e.DojahError("Failed to verify bvn");
                error.status = 500;
                throw error;
            }
            return {
                status: true,
                responseCode: resp.status,
                data: resp.data,
            };
        } catch (error) {
            this.handleDojahError(error);
        }
    }

    async verifyNin(
        options: t.VerifyNinOptions
    ): Promise<t.DojahResponse<t.VerifyNinResponseData>> {
        try {
            const requestOptions: AxiosRequestConfig = {
                url: "/api/v1/kyc/nin",
                method: "GET",
                params: {
                    nin: options.nin,
                    first_name: options.first_name,
                    last_name: options.last_name,
                    dob: options.dob,
                } as t.VerifyNinOptions,
            };
            const resp = await this.axios<t.VerifyNinResponseData>(
                requestOptions
            );

            if (!resp.data) {
                const error = new e.DojahError("Failed to verify NIN");
                error.status = 500;
                throw error;
            }
            return {
                status: true,
                responseCode: resp.status,
                data: resp.data,
            };
        } catch (error) {
            this.handleDojahError(error);
        }
    }
}
