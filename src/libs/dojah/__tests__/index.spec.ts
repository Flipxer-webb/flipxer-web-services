const axiosCallMock = jest.fn();
const createMock = jest.fn(() => axiosCallMock as any);

jest.mock("axios", () => {
    const axiosDefault: any = jest.fn();
    axiosDefault.create = createMock;

    return {
        __esModule: true,
        default: axiosDefault,
        create: createMock,
    };
});

import { DojahLib } from "../index";
import {
    DojahAuthorizationError,
    DojahGenericError,
    DojahLowBalanceError,
    DojahMethodNotFoundError,
    DojahNetworkError,
    DojahNotFoundError,
    DojahRequestTimeoutError,
    DojahThirdPartyServiceFailureError,
    DojahTooManyRequestError,
    DojahValidationError,
} from "../errors";

describe("DojahLib", () => {
    const options = {
        baseURL: "https://api.dojah.test",
        appId: "app-1",
        apiKey: "api-key",
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("creates axios instance with expected headers", () => {
        const lib = new DojahLib(options);

        expect(lib).toBeDefined();
        expect(createMock).toHaveBeenCalledWith({
            baseURL: options.baseURL,
            headers: {
                Authorization: options.apiKey,
                AppId: options.appId,
            },
        });
    });

    it("verifyBvn sends request and returns normalized response", async () => {
        axiosCallMock.mockResolvedValueOnce({
            status: 200,
            data: {
                entity: {
                    bvn: "12345678901",
                    first_name: "John",
                    last_name: "Doe",
                },
            },
        });

        const lib = new DojahLib(options);
        const result = await lib.verifyBvn({
            bvn: "12345678901",
            first_name: "John",
        });

        expect(axiosCallMock).toHaveBeenCalledWith({
            url: "/api/v1/kyc/bvn/full",
            method: "GET",
            params: {
                bvn: "12345678901",
                first_name: "John",
                last_name: undefined,
                dob: undefined,
            },
        });
        expect(result).toEqual({
            status: true,
            responseCode: 200,
            data: {
                entity: {
                    bvn: "12345678901",
                    first_name: "John",
                    last_name: "Doe",
                },
            },
        });
    });

    it("verifyNin sends request and returns normalized response", async () => {
        axiosCallMock.mockResolvedValueOnce({
            status: 200,
            data: {
                entity: {
                    nin: "12345678901",
                    first_name: "Ada",
                },
            },
        });

        const lib = new DojahLib(options);
        const result = await lib.verifyNin({
            nin: "12345678901",
            first_name: "Ada",
            last_name: "Lovelace",
        });

        expect(axiosCallMock).toHaveBeenCalledWith({
            url: "/api/v1/kyc/nin",
            method: "GET",
            params: {
                nin: "12345678901",
                first_name: "Ada",
                last_name: "Lovelace",
                dob: undefined,
            },
        });
        expect(result).toEqual({
            status: true,
            responseCode: 200,
            data: {
                entity: {
                    nin: "12345678901",
                    first_name: "Ada",
                },
            },
        });
    });

    it("analyzeDocument uses default base64 input and optional back side", async () => {
        axiosCallMock.mockResolvedValueOnce({
            status: 200,
            data: { entity: { status: { overall_status: 1 } } },
        });

        const lib = new DojahLib(options);
        await lib.analyzeDocument({
            imageFrontSide: "front-base64",
            imageBackSide: "back-base64",
        });

        expect(axiosCallMock).toHaveBeenCalledWith({
            url: "/api/v1/document/analysis",
            method: "POST",
            data: {
                input_type: "base64",
                imagefrontside: "front-base64",
                imagebackside: "back-base64",
            },
        });
    });

    it("analyzeDocument supports explicit input type without back side", async () => {
        axiosCallMock.mockResolvedValueOnce({
            status: 200,
            data: { entity: { status: { overall_status: 1 } } },
        });

        const lib = new DojahLib(options);
        await lib.analyzeDocument({
            inputType: "url",
            imageFrontSide: "https://cdn.example/front.png",
        });

        expect(axiosCallMock).toHaveBeenCalledWith({
            url: "/api/v1/document/analysis",
            method: "POST",
            data: {
                input_type: "url",
                imagefrontside: "https://cdn.example/front.png",
            },
        });
    });

    it("lookupCAC and verifyTIN return normalized responses", async () => {
        axiosCallMock
            .mockResolvedValueOnce({
                status: 200,
                data: { entity: { rc_number: "RC-123" } },
            })
            .mockResolvedValueOnce({
                status: 200,
                data: { entity: { tin: "TIN-123" } },
            });

        const lib = new DojahLib(options);
        const cac = await lib.lookupCAC({ rcNumber: "RC-123" });
        const tin = await lib.verifyTIN({ tin: "TIN-123" });

        expect(cac.responseCode).toBe(200);
        expect(cac.data).toEqual({ entity: { rc_number: "RC-123" } });
        expect(tin.responseCode).toBe(200);
        expect(tin.data).toEqual({ entity: { tin: "TIN-123" } });
    });

    it("getVerificationResult returns null when api responds without payload", async () => {
        axiosCallMock.mockResolvedValueOnce({
            status: 200,
            data: null,
        });

        const lib = new DojahLib(options);
        const result = await lib.getVerificationResult("ref-empty");

        expect(result).toBeNull();
    });

    it("getVerificationResult returns null for 404", async () => {
        axiosCallMock.mockRejectedValueOnce({
            response: {
                status: 404,
            },
        });

        const lib = new DojahLib(options);
        const result = await lib.getVerificationResult("ref-404");

        expect(result).toBeNull();
    });

    it("getVerificationResult returns normalized response when found", async () => {
        axiosCallMock.mockResolvedValueOnce({
            status: 200,
            data: {
                entity: {
                    id: "ref-1",
                },
            },
        });

        const lib = new DojahLib(options);
        const result = await lib.getVerificationResult("ref-1");

        expect(axiosCallMock).toHaveBeenCalledWith({
            url: "/api/v1/kyc/verification",
            method: "GET",
            params: {
                reference_id: "ref-1",
            },
        });
        expect(result?.status).toBe(true);
        expect(result?.responseCode).toBe(200);
    });

    it("parseDocumentData extracts fields and flags", () => {
        const lib = new DojahLib(options);

        const parsed = lib.parseDocumentData({
            entity: {
                status: {
                    overall_status: 1,
                    reason: "valid",
                    document_images: "Yes",
                    text: "Yes",
                    document_type: "Yes",
                    expiry: "Yes",
                },
                document_type: {
                    document_name: "Passport",
                    document_country_name: "Nigeria",
                    document_country_code: "NG",
                },
                document_images: {
                    portrait: "img-1",
                    document_front_side: "img-front",
                },
                text_data: [
                    {
                        field_name: "First name",
                        field_key: "first_name",
                        status: 1,
                        value: "Jane",
                    },
                    {
                        field_name: "Last name",
                        field_key: "last_name",
                        status: 1,
                        value: "Doe",
                    },
                    {
                        field_name: "Document number",
                        field_key: "document_number",
                        status: 1,
                        value: "A12345",
                    },
                ],
            },
        } as any);

        expect(parsed.isValid).toBe(true);
        expect(parsed.documentType).toBe("Passport");
        expect(parsed.countryCode).toBe("NG");
        expect(parsed.firstName).toBe("Jane");
        expect(parsed.lastName).toBe("Doe");
        expect(parsed.hasPortrait).toBe(true);
        expect(parsed.hasFrontSide).toBe(true);
        expect(parsed.hasBackSide).toBe(false);
        expect(parsed.hasExtractedText).toBe(true);
    });

    it("maps 401 error to DojahAuthorizationError", () => {
        const lib = new DojahLib(options) as any;

        expect(() =>
            lib.handleDojahError({
                response: {
                    status: 401,
                    data: { error: "unauthorized" },
                },
            })
        ).toThrow(DojahAuthorizationError);
    });

    it("maps 400 error to DojahValidationError", () => {
        const lib = new DojahLib(options) as any;

        expect(() =>
            lib.handleDojahError({
                response: {
                    status: 400,
                    data: { error: "invalid" },
                },
            })
        ).toThrow(DojahValidationError);
    });

    it("maps 429 error to DojahTooManyRequestError", () => {
        const lib = new DojahLib(options) as any;

        expect(() =>
            lib.handleDojahError({
                response: {
                    status: 429,
                    data: { error: "rate limited" },
                },
            })
        ).toThrow(DojahTooManyRequestError);
    });

    it("maps additional status codes to specific Dojah errors", () => {
        const lib = new DojahLib(options) as any;

        expect(() =>
            lib.handleDojahError({
                response: {
                    status: 402,
                    data: { error: "low balance" },
                },
            })
        ).toThrow(DojahLowBalanceError);

        expect(() =>
            lib.handleDojahError({
                response: {
                    status: 404,
                    data: { error: "not found" },
                },
            })
        ).toThrow(DojahNotFoundError);

        expect(() =>
            lib.handleDojahError({
                response: {
                    status: 405,
                    data: { error: "method" },
                },
            })
        ).toThrow(DojahMethodNotFoundError);

        expect(() =>
            lib.handleDojahError({
                response: {
                    status: 408,
                    data: { error: "timeout" },
                },
            })
        ).toThrow(DojahRequestTimeoutError);

        expect(() =>
            lib.handleDojahError({
                response: {
                    status: 424,
                    data: { error: "third-party failed" },
                },
            })
        ).toThrow(DojahThirdPartyServiceFailureError);
    });

    it("maps network timeout to DojahNetworkError", () => {
        const lib = new DojahLib(options) as any;

        try {
            lib.handleDojahError({
                code: "ECONNABORTED",
                message: "timeout",
            });
        } catch (error) {
            expect(error).toBeInstanceOf(DojahNetworkError);
            expect((error as Error).message).toContain("timeout");
        }
    });

    it("maps unresolved host network failure to DojahNetworkError", () => {
        const lib = new DojahLib(options) as any;

        try {
            lib.handleDojahError({
                code: "ENOTFOUND",
                message: "host not found",
            });
        } catch (error) {
            expect(error).toBeInstanceOf(DojahNetworkError);
            expect((error as Error).message).toContain("Could not reach Dojah API");
        }
    });

    it("maps unknown status to DojahGenericError and preserves status", () => {
        const lib = new DojahLib(options) as any;

        try {
            lib.handleDojahError({
                response: {
                    status: 500,
                    statusText: "Server Error",
                    data: { error: "boom" },
                },
            });
        } catch (error) {
            expect(error).toBeInstanceOf(DojahGenericError);
            expect(error).toMatchObject({
                message: "boom",
                status: 500,
            });
        }
    });
});
