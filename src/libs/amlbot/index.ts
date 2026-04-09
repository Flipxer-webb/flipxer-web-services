import { createHash } from "node:crypto";
import * as e from "./errors";
import Axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from "axios";
export * from "./errors";
export * from "./types";
import * as t from "./types";
import * as qs from "querystring";

export class AmlBotLib {
    constructor(protected instanceOptions: t.AmlBotOptions) {}

    private readonly axios: AxiosInstance = Axios.create({
        baseURL: this.instanceOptions.baseURL,
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
    });

    private md5(input: string): string {
        return createHash("md5").update(input).digest("hex");
    }

    private generateToken(hash: string): string {
        return this.md5(
            `${hash}:${this.instanceOptions.accessKey}:${this.instanceOptions.accessId}`
        );
    }

    private generateRecheckToken(uid: string): string {
        return this.md5(
            `${uid}:${this.instanceOptions.accessKey}:${this.instanceOptions.accessId}`
        );
    }

    private generateHistoryToken(page: number = 0): string {
        return this.md5(
            `${page}:${this.instanceOptions.accessKey}:${this.instanceOptions.accessId}`
        );
    }

    private handleAmlBotError(error: AxiosError<any>) {
        if (!error.response) {
            let message = error.message || "Network error connecting to AMLBot";

            if (error.code === "ECONNABORTED") {
                message = "Request timeout - AMLBot API took too long to respond";
            } else if (error.code === "ENOTFOUND") {
                message = "Network error - Could not reach AMLBot API";
            }

            throw new e.AmlBotNetworkError(message);
        }

        switch (true) {
            case error.response?.status === 401: {
                throw new e.AmlBotAuthorizationError(
                    error.response.data?.description || "Unauthorized"
                );
            }
            case error.response?.status === 400: {
                throw new e.AmlBotValidationError(
                    error.response.data?.description || "Invalid request"
                );
            }
            case error.response?.status === 429: {
                throw new e.AmlBotRateLimitError(
                    error.response.data?.description || "Rate limit exceeded"
                );
            }
            default: {
                const err = new e.AmlBotGenericError(
                    error.response?.data?.description || error.response?.statusText
                );
                err.status = error.response?.status;
                throw err;
            }
        }
    }

    private handleResultError(data: t.AmlBotResponse<any>) {
        if (!data.result) {
            if (data.description === "Invalid token") {
                throw new e.AmlBotAuthorizationError("Invalid token - check accessKey and accessId");
            }
            throw new e.AmlBotValidationError(
                data.description || "AMLBot request failed"
            );
        }
    }

    async getSupportedCoins(): Promise<any> {
        try {
            const resp = await this.axios<any>({
                url: "/coins/",
                method: "GET",
            });
            return resp.data;
        } catch (error) {
            this.handleAmlBotError(error);
        }
    }

    async checkAddress(
        options: t.AmlBotAddressCheckOptions
    ): Promise<t.AmlBotResponse<t.AmlBotAddressData>> {
        try {
            const token = this.generateToken(options.hash);
            const requestOptions: AxiosRequestConfig = {
                url: "/",
                method: "POST",
                data: qs.stringify({
                    accessId: this.instanceOptions.accessId,
                    hash: options.hash,
                    asset: options.asset,
                    token,
                    ...(options.locale && { locale: options.locale }),
                }),
            };
            const resp = await this.axios<t.AmlBotResponse<t.AmlBotAddressData>>(
                requestOptions
            );

            this.handleResultError(resp.data);
            return resp.data;
        } catch (error) {
            if (error instanceof e.AmlBotError) throw error;
            this.handleAmlBotError(error);
        }
    }

    async checkTransaction(
        options: t.AmlBotTransactionCheckOptions
    ): Promise<t.AmlBotResponse<t.AmlBotTransactionData>> {
        try {
            const token = this.generateToken(options.hash);
            const requestOptions: AxiosRequestConfig = {
                url: "/",
                method: "POST",
                data: qs.stringify({
                    accessId: this.instanceOptions.accessId,
                    hash: options.hash,
                    address: options.address,
                    direction: options.direction,
                    asset: options.asset,
                    token,
                    ...(options.locale && { locale: options.locale }),
                }),
            };
            const resp = await this.axios<
                t.AmlBotResponse<t.AmlBotTransactionData>
            >(requestOptions);

            this.handleResultError(resp.data);
            return resp.data;
        } catch (error) {
            if (error instanceof e.AmlBotError) throw error;
            this.handleAmlBotError(error);
        }
    }

    async recheck(
        options: t.AmlBotRecheckOptions
    ): Promise<t.AmlBotResponse<t.AmlBotAddressData | t.AmlBotTransactionData>> {
        try {
            const token = this.generateRecheckToken(options.uid);
            const requestOptions: AxiosRequestConfig = {
                url: "/recheck",
                method: "POST",
                data: qs.stringify({
                    accessId: this.instanceOptions.accessId,
                    uid: options.uid,
                    token,
                }),
            };
            const resp = await this.axios<
                t.AmlBotResponse<t.AmlBotAddressData | t.AmlBotTransactionData>
            >(requestOptions);

            this.handleResultError(resp.data);
            return resp.data;
        } catch (error) {
            if (error instanceof e.AmlBotError) throw error;
            this.handleAmlBotError(error);
        }
    }

    async investigate(
        options: t.AmlBotInvestigationOptions
    ): Promise<t.AmlBotResponse<t.AmlBotInvestigationData>> {
        try {
            const token = this.generateToken(options.hash);
            const requestOptions: AxiosRequestConfig = {
                url: "/",
                method: "POST",
                data: qs.stringify({
                    accessId: this.instanceOptions.accessId,
                    hash: options.hash,
                    asset: options.asset,
                    expanded: 1,
                    token,
                    ...(options.tokenData && { tokenData: options.tokenData }),
                    ...(options.locale && { locale: options.locale }),
                }),
            };
            const resp = await this.axios<
                t.AmlBotResponse<t.AmlBotInvestigationData>
            >(requestOptions);

            this.handleResultError(resp.data);
            return resp.data;
        } catch (error) {
            if (error instanceof e.AmlBotError) throw error;
            this.handleAmlBotError(error);
        }
    }

    async getHistory(
        options?: t.AmlBotHistoryOptions
    ): Promise<t.AmlBotHistoryResponse> {
        try {
            const page = options?.page ?? 0;
            const token = this.generateHistoryToken(page);
            const requestOptions: AxiosRequestConfig = {
                url: "/history/",
                method: "POST",
                data: qs.stringify({
                    accessId: this.instanceOptions.accessId,
                    page,
                    token,
                    ...(options?.address !== undefined && { address: options.address }),
                    ...(options?.tx !== undefined && { tx: options.tx }),
                    ...(options?.asset && { asset: options.asset }),
                }),
            };
            const resp = await this.axios<t.AmlBotHistoryResponse>(
                requestOptions
            );

            if (!(resp.data as any).result) {
                this.handleResultError(resp.data as any);
            }
            return resp.data;
        } catch (error) {
            if (error instanceof e.AmlBotError) throw error;
            this.handleAmlBotError(error);
        }
    }
}
