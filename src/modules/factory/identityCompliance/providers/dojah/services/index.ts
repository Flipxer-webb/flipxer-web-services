import * as DJ from "@/libs/dojah";
import { HttpStatus, Logger } from "@nestjs/common";
import { matchNames, NameMatchResult } from "@/utils/name-matcher";
import * as e from "../errors";

export class DojahService {
    private readonly logger = new Logger(DojahService.name);
    constructor(private readonly dojah: DJ.DojahLib) { }

    private buildDocumentNameCandidates(parsed: DJ.ParsedDocumentData) {
        const candidates = new Map<string, { providerFirst: string; providerLast: string; source: string }>();
        const addCandidate = (providerFirst?: string, providerLast?: string, source?: string) => {
            if (!providerFirst || !providerLast || !source) {
                return;
            }

            const key = `${providerFirst}::${providerLast}`.toLowerCase().trim();
            if (!key || candidates.has(key)) {
                return;
            }

            candidates.set(key, { providerFirst, providerLast, source });
        };

        addCandidate(parsed.firstName, parsed.lastName, "first_name+last_name");
        addCandidate(parsed.givenNames, parsed.lastName, "given_names+last_name");

        const firstGivenName = parsed.givenNames?.split(/\s+/).find(Boolean);
        addCandidate(firstGivenName, parsed.lastName, "given_name_token+last_name");

        return [...candidates.values()];
    }

    async verifyBvn(options: DJ.VerifyBvnOptions) {
        try {
            const resp = await this.dojah.verifyBvn({
                bvn: options.bvn,
                first_name: options.first_name,
                last_name: options.last_name,
                dob: options.dob,
            });

            if (!resp) {
                throw new e.DojahException(
                    `Unable to initiate bvn verification`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.handleVerificationError(error, "bvn");
        }
    }

    async verifyNin(options: DJ.VerifyNinOptions) {
        try {
            const resp = await this.dojah.verifyNin({
                nin: options.nin,
                first_name: options.first_name,
                last_name: options.last_name,
                dob: options.dob,
            });

            if (!resp) {
                throw new e.DojahException(
                    `Unable to initiate NIN verification`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.handleVerificationError(error, "NIN");
        }
    }

    /**
     * Analyze and verify a document using Dojah's Document Analysis API
     * Supports passports, driver's licenses, national IDs, etc.
     */
    async analyzeDocument(options: DJ.DocumentAnalysisOptions): Promise<{
        response: DJ.DojahResponse<DJ.DocumentAnalysisResponseData>;
        parsed: DJ.ParsedDocumentData;
    }> {
        try {
            const resp = await this.dojah.analyzeDocument({
                imageFrontSide: options.imageFrontSide,
                imageBackSide: options.imageBackSide,
                inputType: options.inputType || "base64",
            });

            if (!resp) {
                throw new e.DojahException(
                    `Unable to analyze document`,
                    HttpStatus.BAD_REQUEST
                );
            }

            const parsed = this.dojah.parseDocumentData(resp.data);

            // Log full Dojah response for debugging
            this.logger.log(
                `Document analysis completed: valid=${parsed.isValid}, type=${parsed.documentType}, country=${parsed.country}, reason=${parsed.reason}`
            );

            // Log raw response status for debugging invalid documents
            if (!parsed.isValid) {
                this.logger.warn(`Document INVALID - Full status:`, {
                    overallStatus: resp.data?.entity?.status?.overall_status,
                    reason: resp.data?.entity?.status?.reason,
                    documentType: resp.data?.entity?.document_type,
                    textDataCount: resp.data?.entity?.text_data?.length || 0,
                });
            }

            return { response: resp, parsed };
        } catch (error) {
            this.handleVerificationError(error, "document");
        }
    }

    /**
     * Verify document and check if extracted name matches user's name
     */
    async verifyDocumentWithNameMatch(
        options: DJ.DocumentAnalysisOptions,
        expectedFirstName: string,
        expectedLastName: string
    ): Promise<{
        isValid: boolean;
        nameMatches: boolean;
        parsed: DJ.ParsedDocumentData;
        matchDetails: {
            expectedFirst: string;
            expectedLast: string;
            extractedFirst?: string;
            extractedLast?: string;
            extractedGivenNames?: string;
        };
    }> {
        const { parsed } = await this.analyzeDocument(options);

        const nameCandidates = this.buildDocumentNameCandidates(parsed);
        const bestMatch = nameCandidates.reduce<
            { candidate: { providerFirst: string; providerLast: string; source: string }; result: NameMatchResult } | null
        >((best, candidate) => {
            const result = matchNames(
                expectedFirstName,
                expectedLastName,
                candidate.providerFirst,
                candidate.providerLast,
            );

            if (!best || result.score > best.result.score) {
                return { candidate, result };
            }

            return best;
        }, null);

        const nameMatches = bestMatch?.result.matches ?? false;

        this.logger.log(
            `Document name verification: expected="${expectedFirstName} ${expectedLastName}", ` +
            `extracted="${parsed.firstName || ""} ${parsed.lastName || ""}", ` +
            `matches=${nameMatches}, ` +
            `candidate=${bestMatch?.candidate.source || "none"}, ` +
            `detail=${bestMatch?.result.detail || "missing extracted names"}`
        );

        return {
            isValid: parsed.isValid,
            nameMatches,
            parsed,
            matchDetails: {
                expectedFirst: expectedFirstName,
                expectedLast: expectedLastName,
                extractedFirst: parsed.firstName,
                extractedLast: parsed.lastName,
                extractedGivenNames: parsed.givenNames,
            },
        };
    }

    /**
     * Get verification result by reference/verification ID
     * Helper wrapper for DojahLib.getVerificationResult
     */
    async getVerificationResult(verificationId: string): Promise<{ verified: boolean; status: string; data?: any }> {
        try {
            const resp = await this.dojah.getVerificationResult(verificationId);

            if (!resp?.data) {
                return { verified: false, status: 'not_found' };
            }

            const entity = resp.data?.entity || resp.data;

            const verified = (entity.status === true || entity.status === "valid" || entity.status === "success") &&
                (entity.verification_status === "Completed" || !entity.verification_status);

            this.logger.log(`Verification result for ${verificationId}: verified=${verified}, status=${entity?.status}`);

            return {
                verified: verified,
                status: resp.data.status || 'unknown',
                data: resp.data
            };
        } catch (error) {
            this.logger.error(`Failed to get verification result: ${error.message}`);
            return { verified: false, status: 'error' };
        }
    }

    private handleVerificationError(error: any, verificationType: string): never {
        this.logger.error(error);

        if (error instanceof e.DojahException) {
            throw error;
        }

        if (error instanceof DJ.DojahError) {
            throw new e.DojahException(
                error.message ??
                `Failed to initiate ${verificationType} verification. Please try again`,
                error.status ?? HttpStatus.BAD_REQUEST,
                {
                    responseBody: error.responseBody,
                    requestMetadata: error.requestMetadata,
                    providerErrorName: error.name,
                },
            );
        }

        throw new e.DojahException(
            "Failed to initiate verification",
            HttpStatus.NOT_IMPLEMENTED
        );
    }

    /**
     * Lookup a company by CAC RC number
     */
    async lookupCAC(rcNumber: string): Promise<DJ.DojahResponse<DJ.CACLookupResponseData>> {
        try {
            const resp = await this.dojah.lookupCAC({ rcNumber });

            if (!resp) {
                throw new e.DojahException(
                    `Unable to lookup CAC registration`,
                    HttpStatus.BAD_REQUEST
                );
            }

            this.logger.log(
                `CAC lookup completed for RC ${rcNumber}: company=${resp.data?.entity?.company_name}, status=${resp.data?.entity?.company_status}`
            );

            return resp;
        } catch (error) {
            this.handleVerificationError(error, "CAC");
        }
    }

    /**
     * Verify a Tax Identification Number (TIN)
     */
    async verifyTIN(tin: string): Promise<DJ.DojahResponse<DJ.TINVerifyResponseData>> {
        try {
            const resp = await this.dojah.verifyTIN({ tin });

            if (!resp) {
                throw new e.DojahException(
                    `Unable to verify TIN`,
                    HttpStatus.BAD_REQUEST
                );
            }

            this.logger.log(
                `TIN verification completed for ${tin}: taxpayer=${resp.data?.entity?.taxpayer_name}`
            );

            return resp;
        } catch (error) {
            this.handleVerificationError(error, "TIN");
        }
    }

    /**
     * Orchestrate all business document verifications:
     * 1. CAC lookup by RC number
     * 2. TIN verification
     * 3. CAC document OCR (extract text from document image)
     * 
     * All checks run in parallel via Promise.allSettled (non-blocking).
     * Returns structured results for storage.
     */
    async verifyBusinessDocuments(options: {
        cacDocumentNumber: string;
        taxIdentificationNumber?: string;
        cacImageBase64?: string;
        businessName: string;
    }): Promise<DJ.BusinessVerificationResult> {
        const normalize = (s?: string) => s?.toLowerCase().trim() || "";
        const expectedName = normalize(options.businessName);

        const results: DJ.BusinessVerificationResult = {
            cac: { verified: false },
            tin: { verified: false },
            ocr: { verified: false },
        };

        // Run all checks in parallel
        const [cacResult, tinResult, ocrResult] = await Promise.allSettled([
            // 1. CAC Lookup
            this.lookupCAC(options.cacDocumentNumber),
            // 2. TIN Verification
            options.taxIdentificationNumber
                ? this.verifyTIN(options.taxIdentificationNumber)
                : Promise.resolve(null),
            // 3. CAC Document OCR
            options.cacImageBase64
                ? this.analyzeDocument({
                    imageFrontSide: options.cacImageBase64,
                    inputType: "base64",
                })
                : Promise.resolve(null),
        ]);

        // Process CAC result
        if (cacResult.status === "fulfilled" && cacResult.value) {
            const entity = cacResult.value.data?.entity;
            const companyName = entity?.company_name || "";
            const nameMatches =
                normalize(companyName).includes(expectedName) ||
                expectedName.includes(normalize(companyName));

            results.cac = {
                verified: true,
                companyName,
                companyStatus: entity?.company_status,
                registrationDate: entity?.registration_date,
                nameMatches,
                rawResponse: JSON.stringify(cacResult.value.data),
            };
        } else if (cacResult.status === "rejected") {
            this.logger.warn(
                `CAC lookup failed for RC ${options.cacDocumentNumber}: ${cacResult.reason?.message}`
            );
            results.cac = {
                verified: false,
                rawResponse: JSON.stringify({ error: cacResult.reason?.message }),
            };
        }

        // Process TIN result
        if (tinResult.status === "fulfilled" && tinResult.value) {
            const entity = tinResult.value.data?.entity;
            const taxpayerName = entity?.taxpayer_name || "";
            const nameMatches =
                normalize(taxpayerName).includes(expectedName) ||
                expectedName.includes(normalize(taxpayerName));

            results.tin = {
                verified: true,
                taxpayerName,
                nameMatches,
                rawResponse: JSON.stringify(tinResult.value.data),
            };
        } else if (tinResult.status === "rejected") {
            this.logger.warn(
                `TIN verification failed for ${options.taxIdentificationNumber}: ${tinResult.reason?.message}`
            );
            results.tin = {
                verified: false,
                rawResponse: JSON.stringify({ error: tinResult.reason?.message }),
            };
        }

        // Process OCR result
        if (ocrResult.status === "fulfilled" && ocrResult.value) {
            const { parsed } = ocrResult.value as {
                response: DJ.DojahResponse<DJ.DocumentAnalysisResponseData>;
                parsed: DJ.ParsedDocumentData;
            };
            const extractedNumber = parsed.documentNumber || "";
            const extractedName = [parsed.firstName, parsed.lastName]
                .filter(Boolean)
                .join(" ");
            const numberMatches =
                normalize(extractedNumber) ===
                normalize(options.cacDocumentNumber);

            results.ocr = {
                verified: parsed.isValid,
                extractedNumber,
                extractedName,
                numberMatches,
                rawResponse: JSON.stringify(ocrResult.value),
            };
        } else if (ocrResult.status === "rejected") {
            this.logger.warn(
                `CAC document OCR failed: ${ocrResult.reason?.message}`
            );
            results.ocr = {
                verified: false,
                rawResponse: JSON.stringify({ error: ocrResult.reason?.message }),
            };
        }

        this.logger.log(
            `Business verification completed: CAC=${results.cac.verified}(nameMatch=${results.cac.nameMatches}), ` +
            `TIN=${results.tin.verified}(nameMatch=${results.tin.nameMatches}), ` +
            `OCR=${results.ocr.verified}(numMatch=${results.ocr.numberMatches})`
        );

        return results;
    }
}
