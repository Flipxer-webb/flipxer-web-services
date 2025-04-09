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
