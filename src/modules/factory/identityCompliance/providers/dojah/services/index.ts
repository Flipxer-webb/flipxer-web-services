import * as DJ from "@/libs/dojah";
import { HttpStatus, Logger } from "@nestjs/common";
import * as t from "../types";
import * as e from "../errors";

export class DojahService {
    private readonly logger = new Logger(DojahService.name);
    constructor(private readonly dojah: DJ.DojahLib) {}

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

        // Normalize names for comparison (lowercase, trim)
        const normalize = (s?: string) => s?.toLowerCase().trim() || "";

        const expectedFirst = normalize(expectedFirstName);
        const expectedLast = normalize(expectedLastName);
        const extractedFirst = normalize(parsed.firstName);
        const extractedLast = normalize(parsed.lastName);
        const extractedGivenNames = normalize(parsed.givenNames);

        // Check name match - be flexible with given names vs first name
        const firstNameMatches =
            extractedFirst === expectedFirst ||
            extractedGivenNames.includes(expectedFirst) ||
            expectedFirst.includes(extractedFirst);

        const lastNameMatches =
            extractedLast === expectedLast ||
            expectedLast.includes(extractedLast) ||
            extractedLast.includes(expectedLast);

        const nameMatches = firstNameMatches && lastNameMatches;

        this.logger.log(
            `Document name verification: expected="${expectedFirstName} ${expectedLastName}", ` +
                `extracted="${parsed.firstName || ""} ${parsed.lastName || ""}", ` +
                `matches=${nameMatches}`
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
     * Validate a widget verification result by fetching it from Dojah API
     * This provides server-to-server validation of client-side verification claims
     */
    async getVerificationResult(verificationId: string): Promise<{
        verified: boolean;
        status: string;
        data: any;
    }> {
        try {
            const result = await this.dojah.getVerificationResult(verificationId);
            
            if (!result) {
                this.logger.warn(`Verification result not found for ID: ${verificationId}`);
                return {
                    verified: false,
                    status: "not_found",
                    data: null,
                };
            }

            const entity = result.data?.entity || result.data;
            const verified = entity?.status === "verified" || 
                            entity?.overall_status === "verified";
            
            this.logger.log(`Verification result for ${verificationId}: verified=${verified}, status=${entity?.status}`);
            
            return {
                verified,
                status: entity?.status || "unknown",
                data: entity,
            };
        } catch (error) {
            this.logger.error(`Failed to fetch verification result for ${verificationId}:`, error);
            // Return as unverified if we can't fetch the result
            return {
                verified: false,
                status: "fetch_error",
                data: null,
            };
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
                error.status ?? HttpStatus.BAD_REQUEST
            );
        }

        throw new e.DojahException(
            "Failed to initiate verification",
            HttpStatus.NOT_IMPLEMENTED
        );
    }
}
