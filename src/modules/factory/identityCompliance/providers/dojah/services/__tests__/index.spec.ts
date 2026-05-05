import { HttpStatus } from "@nestjs/common";

import { DojahThirdPartyServiceFailureError, DojahValidationError } from "@/libs/dojah";

import { DojahException } from "../../errors";
import { DojahService } from "../index";

function makeDojahMock() {
    return {
        verifyBvn: jest.fn(),
        verifyNin: jest.fn(),
        analyzeDocument: jest.fn(),
        parseDocumentData: jest.fn(),
        getVerificationResult: jest.fn(),
        lookupCAC: jest.fn(),
        verifyTIN: jest.fn(),
    };
}

describe("DojahService", () => {
    let dojah: ReturnType<typeof makeDojahMock>;
    let service: DojahService;

    beforeEach(() => {
        dojah = makeDojahMock();
        service = new DojahService(dojah as any);

        jest.spyOn((service as any).logger, "log").mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.clearAllMocks();
    });

    it("verifyBvn and verifyNin should return Dojah responses", async () => {
        dojah.verifyBvn.mockResolvedValue({ status: true, data: { entity: { status: true } } });
        dojah.verifyNin.mockResolvedValue({ status: true, data: { entity: { status: true } } });

        const bvn = await service.verifyBvn({ bvn: "123", first_name: "A", last_name: "B", dob: "1990-01-01" } as any);
        const nin = await service.verifyNin({ nin: "123", first_name: "A", last_name: "B", dob: "1990-01-01" } as any);

        expect(bvn.status).toBe(true);
        expect(nin.status).toBe(true);
    });

    it("verify methods should throw DojahException for null response", async () => {
        dojah.verifyBvn.mockResolvedValue(null);

        await expect(
            service.verifyBvn({ bvn: "123", first_name: "A", last_name: "B", dob: "1990-01-01" } as any),
        ).rejects.toBeInstanceOf(DojahException);
    });

    it("verify methods should translate Dojah library errors", async () => {
        dojah.verifyNin.mockRejectedValue(new DojahValidationError("invalid nin"));

        try {
            await service.verifyNin({ nin: "bad", first_name: "A", last_name: "B", dob: "1990-01-01" } as any);
            fail("Expected verifyNin to throw");
        } catch (error) {
            const typedError = error as DojahException;
            expect(typedError).toBeInstanceOf(DojahException);
            expect(typedError.getStatus()).toBe(HttpStatus.BAD_REQUEST);
        }
    });

    it("preserves Dojah library metadata on translated exceptions", async () => {
        const upstreamError = new DojahThirdPartyServiceFailureError("Service not available");
        upstreamError.responseBody = { error: "Service not available" };
        upstreamError.requestMetadata = {
            method: "POST",
            url: "/api/v1/document/analysis",
            baseURL: "https://api.dojah.io",
        };
        dojah.analyzeDocument.mockRejectedValue(upstreamError);

        try {
            await service.analyzeDocument({ imageFrontSide: "base64-image" } as any);
            fail("Expected analyzeDocument to throw");
        } catch (error) {
            const typedError = error as DojahException;
            expect(typedError).toBeInstanceOf(DojahException);
            expect(typedError.getStatus()).toBe(HttpStatus.FAILED_DEPENDENCY);
            expect(typedError.message).toBe("Service not available");
            expect(typedError.responseBody).toEqual({ error: "Service not available" });
            expect(typedError.requestMetadata).toEqual({
                method: "POST",
                url: "/api/v1/document/analysis",
                baseURL: "https://api.dojah.io",
            });
            expect(typedError.providerErrorName).toBe("DojahThirdPartyServiceFailureError");
        }
    });

    it("analyzeDocument should return parsed output", async () => {
        const rawResponse = {
            status: true,
            data: {
                entity: {
                    status: { overall_status: "valid", reason: "ok" },
                    document_type: "passport",
                    text_data: [],
                },
            },
        };
        dojah.analyzeDocument.mockResolvedValue(rawResponse);
        dojah.parseDocumentData.mockReturnValue({
            isValid: true,
            documentType: "passport",
            country: "NG",
            reason: "ok",
        });

        const result = await service.analyzeDocument({ imageFrontSide: "base64-image" } as any);

        expect(result.response).toEqual(rawResponse);
        expect(result.parsed.isValid).toBe(true);
    });

    it("verifyDocumentWithNameMatch should reuse fuzzy matching for minor typos", async () => {
        jest.spyOn(service, "analyzeDocument").mockResolvedValue({
            response: { status: true, data: {} } as any,
            parsed: {
                isValid: true,
                firstName: "Emmnauel",
                lastName: "Okafro",
                givenNames: "Emmnauel Chinedu",
            } as any,
        });

        const result = await service.verifyDocumentWithNameMatch(
            { imageFrontSide: "base64-image" } as any,
            "Emmanuel",
            "Okafor",
        );

        expect(result.isValid).toBe(true);
        expect(result.nameMatches).toBe(true);
        expect(result.matchDetails.extractedFirst).toBe("Emmnauel");
    });

    it("verifyDocumentWithNameMatch should fall back to given name tokens", async () => {
        jest.spyOn(service, "analyzeDocument").mockResolvedValue({
            response: { status: true, data: {} } as any,
            parsed: {
                isValid: true,
                firstName: undefined,
                lastName: "Doe",
                givenNames: "John Michael",
            } as any,
        });

        const result = await service.verifyDocumentWithNameMatch(
            { imageFrontSide: "base64-image" } as any,
            "John",
            "Doe",
        );

        expect(result.isValid).toBe(true);
        expect(result.nameMatches).toBe(true);
        expect(result.matchDetails.extractedGivenNames).toBe("John Michael");
    });

    it("getVerificationResult should return normalized statuses", async () => {
        dojah.getVerificationResult
            .mockResolvedValueOnce({ data: { status: "ok", entity: { status: true, verification_status: "Completed" } } })
            .mockResolvedValueOnce({ data: null })
            .mockRejectedValueOnce(new Error("upstream down"));

        const success = await service.getVerificationResult("ver-1");
        const notFound = await service.getVerificationResult("ver-2");
        const error = await service.getVerificationResult("ver-3");

        expect(success.verified).toBe(true);
        expect(notFound.status).toBe("not_found");
        expect(error.status).toBe("error");
    });

    it("verifyBusinessDocuments should aggregate fulfilled checks", async () => {
        jest.spyOn(service, "lookupCAC").mockResolvedValue({
            status: true,
            data: {
                entity: {
                    company_name: "Acme Corp",
                    company_status: "ACTIVE",
                    registration_date: "2020-01-01",
                },
            },
        } as any);

        jest.spyOn(service, "verifyTIN").mockResolvedValue({
            status: true,
            data: { entity: { taxpayer_name: "Acme Corp" } },
        } as any);

        jest.spyOn(service, "analyzeDocument").mockResolvedValue({
            response: { status: true, data: {} } as any,
            parsed: {
                isValid: true,
                documentNumber: "RC123",
                firstName: "Acme",
                lastName: "Corp",
            } as any,
        });

        const result = await service.verifyBusinessDocuments({
            cacDocumentNumber: "RC123",
            taxIdentificationNumber: "TIN123",
            cacImageBase64: "base64-image",
            businessName: "Acme Corp",
        });

        expect(result.cac.verified).toBe(true);
        expect(result.cac.nameMatches).toBe(true);
        expect(result.tin.verified).toBe(true);
        expect(result.ocr.verified).toBe(true);
        expect(result.ocr.numberMatches).toBe(true);
    });

    it("verifyBusinessDocuments should keep processing when checks reject", async () => {
        jest.spyOn(service, "lookupCAC").mockRejectedValue(new Error("cac down"));
        jest.spyOn(service, "verifyTIN").mockRejectedValue(new Error("tin down"));
        jest.spyOn(service, "analyzeDocument").mockRejectedValue(new Error("ocr down"));

        const result = await service.verifyBusinessDocuments({
            cacDocumentNumber: "RC999",
            taxIdentificationNumber: "TIN999",
            cacImageBase64: "base64-image",
            businessName: "Unknown LLC",
        });

        expect(result.cac.verified).toBe(false);
        expect(result.tin.verified).toBe(false);
        expect(result.ocr.verified).toBe(false);
        expect(result.cac.rawResponse).toContain("cac down");
        expect(result.tin.rawResponse).toContain("tin down");
        expect(result.ocr.rawResponse).toContain("ocr down");
    });
});