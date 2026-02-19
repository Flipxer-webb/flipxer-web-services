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
        // Handle network errors (no response from server)
        if (!error.response) {
            const message = error.code === 'ECONNABORTED' 
                ? 'Request timeout - Dojah API took too long to respond'
                : error.code === 'ENOTFOUND'
                ? 'Network error - Could not reach Dojah API'
                : error.message || 'Network error connecting to Dojah';
            throw new e.DojahNetworkError(message);
        }

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

    /**
     * Analyze a document (passport, driver's license, national ID, etc.)
     * Uses Dojah's Document Analysis API
     */
    async analyzeDocument(
        options: t.DocumentAnalysisOptions
    ): Promise<t.DojahResponse<t.DocumentAnalysisResponseData>> {
        try {
            const body: Record<string, string> = {
                input_type: options.inputType || "base64",
                imagefrontside: options.imageFrontSide,
            };

            if (options.imageBackSide) {
                body.imagebackside = options.imageBackSide;
            }

            const requestOptions: AxiosRequestConfig = {
                url: "/api/v1/document/analysis",
                method: "POST",
                data: body,
            };

            const resp = await this.axios<t.DocumentAnalysisResponseData>(
                requestOptions
            );

            if (!resp.data) {
                const error = new e.DojahError("Failed to analyze document");
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

    /**
     * Parse document analysis response into a more usable format
     */
    parseDocumentData(data: t.DocumentAnalysisResponseData): t.ParsedDocumentData {
        const entity = data.entity;
        const textData = entity.text_data || [];

        const getFieldValue = (key: string): string | undefined => {
            const field = textData.find((f) => f.field_key === key);
            return field?.status === 1 && field?.value ? field.value : undefined;
        };

        return {
            isValid: entity.status.overall_status === 1,
            reason: entity.status.reason,
            documentType: entity.document_type?.document_name || "",
            country: entity.document_type?.document_country_name || "",
            countryCode: entity.document_type?.document_country_code || "",
            firstName: getFieldValue("first_name"),
            lastName: getFieldValue("last_name"),
            givenNames: getFieldValue("given_names"),
            documentNumber: getFieldValue("document_number"),
            dateOfBirth: getFieldValue("dob"),
            expiryDate: getFieldValue("expiry_date"),
            issueDate: getFieldValue("issue_date"),
            sex: getFieldValue("sex"),
            nationality: getFieldValue("nationality"),
            placeOfBirth: getFieldValue("place_of_birth"),
            address: getFieldValue("address"),
            hasPortrait: entity.status.document_images === "Yes",
            hasFrontSide: !!entity.document_images?.document_front_side,
            hasBackSide: !!entity.document_images?.document_back_side,
            hasExtractedText: entity.status.text === "Yes",
        };
    }

    /**
     * Get verification result by reference/verification ID
     * Used to validate widget verification results server-to-server
     */
    async getVerificationResult(verificationId: string): Promise<t.DojahResponse<any> | null> {
        try {
            const requestOptions: AxiosRequestConfig = {
                url: `/api/v1/kyc/verification`,
                method: "GET",
                params: {
                    reference_id: verificationId
                }
            };
            const resp = await this.axios<any>(requestOptions);

            if (!resp.data) {
                return null;
            }

            return {
                status: true,
                responseCode: resp.status,
                data: resp.data,
            };
        } catch (error) {
            // Return null for 404 (not found) rather than throwing
            if ((error as AxiosError)?.response?.status === 404) {
                return null;
            }
            this.handleDojahError(error as AxiosError);
        }
    }

    async lookupCAC(
        options: t.CACLookupOptions
    ): Promise<t.DojahResponse<t.CACLookupResponseData>> {
        try {
            const requestOptions: AxiosRequestConfig = {
                url: "/api/v1/kyc/cac",
                method: "GET",
                params: {
                    rc_number: options.rcNumber,
                },
            };
            const resp = await this.axios<t.CACLookupResponseData>(
                requestOptions
            );

            if (!resp.data) {
                const error = new e.DojahError("Failed to lookup CAC");
                error.status = 500;
                throw error;
            }
            return {
                status: true,
                responseCode: resp.status,
                data: resp.data,
            };
        } catch (error) {
            this.handleDojahError(error as AxiosError);
        }
    }

    async verifyTIN(
        options: t.TINVerifyOptions
    ): Promise<t.DojahResponse<t.TINVerifyResponseData>> {
        try {
            const requestOptions: AxiosRequestConfig = {
                url: "/api/v1/kyc/tin",
                method: "GET",
                params: {
                    tin: options.tin,
                },
            };
            const resp = await this.axios<t.TINVerifyResponseData>(
                requestOptions
            );

            if (!resp.data) {
                const error = new e.DojahError("Failed to verify TIN");
                error.status = 500;
                throw error;
            }
            return {
                status: true,
                responseCode: resp.status,
                data: resp.data,
            };
        } catch (error) {
            this.handleDojahError(error as AxiosError);
        }
    }
}
