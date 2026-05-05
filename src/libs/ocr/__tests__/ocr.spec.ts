import {
    checkNameInText,
    combineAddressSignals,
    extractTextFromDocument,
    extractDocumentDate,
    OcrDocumentPreparationError,
    isDocumentRecent,
    validateAddressDocument,
    validateIncomeDocument,
} from "../index";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const mockRecognize = jest.fn();
const mockSpawn = spawn as unknown as jest.Mock;

type MockPdftoppmProcess = EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { end: jest.Mock; once: jest.Mock };
    kill: jest.Mock;
};

function createMockPdftoppmProcess(): MockPdftoppmProcess {
    return Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: {
            end: jest.fn(),
            once: jest.fn(),
        },
        kill: jest.fn(),
    });
}

jest.mock("node:child_process", () => ({
    spawn: jest.fn(),
}));

jest.mock("tesseract.js", () => ({
    __esModule: true,
    default: {
        recognize: (...args: unknown[]) => mockRecognize(...args),
    },
}));

describe("OCR Name Matching (checkNameInText)", () => {
    describe("exact matches", () => {
        it("should match full name (first + last)", () => {
            const text = "Account holder: John Doe, 15 Main Street";
            expect(checkNameInText(text, "John", "Doe")).toBe(true);
        });

        it("should match reversed name (last + first)", () => {
            const text = "Customer: Doe John — Billing Statement";
            expect(checkNameInText(text, "John", "Doe")).toBe(true);
        });

        it("should match when both names appear separately", () => {
            const text = "Dear John, your bill for the Doe household is ready";
            expect(checkNameInText(text, "John", "Doe")).toBe(true);
        });

        it("should be case-insensitive", () => {
            const text = "JOHN DOE electricity bill";
            expect(checkNameInText(text, "john", "doe")).toBe(true);
        });
    });

    describe("fuzzy matches (Jaro-Winkler)", () => {
        it("should match minor typos in both names", () => {
            // "Emmnauel" vs "Emmanuel" and "Okafro" vs "Okafor" — realistic typos
            const text = "Bill for Emmnauel Okafro at 5 Main Road";
            expect(checkNameInText(text, "Emmanuel", "Okafor")).toBe(true);
        });

        it("should NOT match when only last name matches (family member)", () => {
            const text = "Bill for Sarah Okafor at 12 Market Street";
            expect(checkNameInText(text, "Emmanuel", "Okafor")).toBe(false);
        });

        it("should NOT match when only first name matches", () => {
            const text = "Statement for Emmanuel Nnamdi, Lagos";
            expect(checkNameInText(text, "Emmanuel", "Okafor")).toBe(false);
        });

        it("should NOT match completely different names", () => {
            const text = "Utility bill for Sarah Williams at 10 Park Lane";
            expect(checkNameInText(text, "Emmanuel", "Okafor")).toBe(false);
        });
    });

    describe("edge cases", () => {
        it("should return false for empty names", () => {
            const text = "Some document text";
            expect(checkNameInText(text, "", "Doe")).toBe(false);
            expect(checkNameInText(text, "John", "")).toBe(false);
        });

        it("should return false for empty text", () => {
            expect(checkNameInText("", "John", "Doe")).toBe(false);
        });
    });
});

describe("Document Date Extraction (extractDocumentDate)", () => {
    describe("DD/MM/YYYY format", () => {
        it("should parse DD/MM/YYYY", () => {
            const text = "Bill dated 15/01/2025 for electricity";
            const result = extractDocumentDate(text);
            expect(result).not.toBeNull();
            expect(result?.getFullYear()).toBe(2025);
            expect(result?.getMonth()).toBe(0); // January = 0
            expect(result?.getDate()).toBe(15);
        });

        it("should parse DD-MM-YYYY", () => {
            const text = "Statement: 08-06-2025";
            const result = extractDocumentDate(text);
            expect(result).not.toBeNull();
            expect(result?.getFullYear()).toBe(2025);
            expect(result?.getMonth()).toBe(5); // June = 5
            expect(result?.getDate()).toBe(8);
        });
    });

    describe("ISO format", () => {
        it("should parse YYYY-MM-DD", () => {
            const text = "Issued: 2025-03-20";
            const result = extractDocumentDate(text);
            expect(result).not.toBeNull();
            expect(result?.getFullYear()).toBe(2025);
            expect(result?.getMonth()).toBe(2); // March = 2
            expect(result?.getDate()).toBe(20);
        });
    });

    describe("named month formats", () => {
        it('should parse "DD Month YYYY"', () => {
            const text = "Issued on 15 January 2025";
            const result = extractDocumentDate(text);
            expect(result).not.toBeNull();
            expect(result?.getFullYear()).toBe(2025);
            expect(result?.getMonth()).toBe(0);
            expect(result?.getDate()).toBe(15);
        });

        it('should parse "Month DD, YYYY"', () => {
            const text = "Date: February 5, 2025";
            const result = extractDocumentDate(text);
            expect(result).not.toBeNull();
            expect(result?.getFullYear()).toBe(2025);
            expect(result?.getMonth()).toBe(1);
            expect(result?.getDate()).toBe(5);
        });

        it("should parse abbreviated month names", () => {
            const text = "Statement for Dec 2024. Due: 15 Dec 2024";
            const result = extractDocumentDate(text);
            expect(result).not.toBeNull();
            expect(result?.getFullYear()).toBe(2024);
            expect(result?.getMonth()).toBe(11);
        });
    });

    describe("multiple dates", () => {
        it("should return the most recent date", () => {
            const text = "Period: 01/01/2025 to 31/03/2025. Due: 15/04/2025";
            const result = extractDocumentDate(text);
            expect(result).not.toBeNull();
            expect(result?.getFullYear()).toBe(2025);
            expect(result?.getMonth()).toBe(3); // April = 3
            expect(result?.getDate()).toBe(15);
        });
    });

    describe("edge cases", () => {
        it("should return null when no date is found", () => {
            const text = "Some document with no date information";
            expect(extractDocumentDate(text)).toBeNull();
        });

        it("should reject invalid dates", () => {
            const text = "Invalid date: 31/02/2025"; // Feb 31 doesn't exist
            expect(extractDocumentDate(text)).toBeNull();
        });

        it("should reject years outside 2000-2099", () => {
            const text = "Historical date: 15/06/1999";
            expect(extractDocumentDate(text)).toBeNull();
        });
    });
});

describe("Document Recency (isDocumentRecent)", () => {
    it("should return true for a recent date (1 month ago)", () => {
        const oneMonthAgo = new Date();
        oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
        expect(isDocumentRecent(oneMonthAgo)).toBe(true);
    });

    it("should return false for an old date (6 months ago)", () => {
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
        expect(isDocumentRecent(sixMonthsAgo)).toBe(false);
    });

    it("should return false for null (no date found)", () => {
        expect(isDocumentRecent(null)).toBe(false);
    });

    it("should return true for today", () => {
        expect(isDocumentRecent(new Date())).toBe(true);
    });
});

describe("OCR Extraction (extractTextFromDocument)", () => {
    beforeEach(() => {
        mockRecognize.mockReset();
        mockSpawn.mockReset();
    });

    it("should return extracted text and confidence on success", async () => {
        mockRecognize.mockResolvedValue({
            data: {
                text: "Sample OCR text",
                confidence: 88,
            },
        });

        const result = await extractTextFromDocument(Buffer.from("image"));

        expect(result).toEqual({
            text: "Sample OCR text",
            confidence: 88,
        });
    });

    it("should return safe fallback when OCR fails", async () => {
        mockRecognize.mockRejectedValue(new Error("ocr failed"));

        const result = await extractTextFromDocument(Buffer.from("image"));

        expect(result).toEqual({ text: "", confidence: 0 });
    });

    it("should rasterize PDF pages before OCR", async () => {
        mockSpawn.mockImplementation((_file: unknown, args: unknown) => {
            const outputPrefix = (args as string[])[6];
            const child = createMockPdftoppmProcess();

            child.stdin = {
                end: jest.fn(() => {
                    writeFileSync(
                        `${outputPrefix}-1.png`,
                        Buffer.from("page-1-image"),
                    );
                    writeFileSync(
                        `${outputPrefix}-2.png`,
                        Buffer.from("page-2-image"),
                    );
                    setImmediate(() => child.emit("close", 0));
                }),
                once: jest.fn(),
            };

            return child;
        });
        mockRecognize
            .mockResolvedValueOnce({
                data: {
                    text: "Page 1 text",
                    confidence: 80,
                },
            })
            .mockResolvedValueOnce({
                data: {
                    text: "Page 2 text",
                    confidence: 60,
                },
            });

        const result = await extractTextFromDocument(
            Buffer.from("%PDF-1.7"),
            "application/pdf",
        );

        expect(mockSpawn).toHaveBeenCalledTimes(1);
        expect(mockSpawn.mock.calls[0][0]).toBe("/usr/bin/pdftoppm");
        expect(mockSpawn.mock.calls[0][1]).toEqual(
            expect.arrayContaining(["-png", "-f", "1", "-l", "3", "-"]),
        );
        expect(mockRecognize).toHaveBeenNthCalledWith(
            1,
            Buffer.from("page-1-image"),
            "eng",
            expect.any(Object),
        );
        expect(mockRecognize).toHaveBeenNthCalledWith(
            2,
            Buffer.from("page-2-image"),
            "eng",
            expect.any(Object),
        );
        expect(result).toEqual({
            text: "Page 1 text\n\nPage 2 text",
            confidence: 70,
        });
    });

    it("should throw a controlled error when PDF rasterization fails", async () => {
        mockSpawn.mockImplementation(() => {
            const child = createMockPdftoppmProcess();

            child.stdin = {
                end: jest.fn(() => {
                    child.stderr.emit("data", "pdftoppm failed");
                    setImmediate(() => child.emit("close", 1));
                }),
                once: jest.fn(),
            };

            return child;
        });

        await expect(
            extractTextFromDocument(Buffer.from("%PDF-1.7"), "application/pdf"),
        ).rejects.toThrow(OcrDocumentPreparationError);

        expect(mockRecognize).not.toHaveBeenCalled();
    });
});

describe("Document Validators", () => {
    beforeEach(() => {
        mockRecognize.mockReset();
    });

    it("lets provider signals rescue a low-confidence address document", () => {
        const result = combineAddressSignals({
            confidence: 25,
            extractedText: "",
            matchedName: false,
            matchedAddress: false,
            matchedResidentialAddress: null,
            addressDocumentType: null,
            documentDate: null,
            providerSignals: {
                documentType: "Utility Bill",
                nameMatches: true,
                documentDate: new Date().toISOString(),
                country: "Nigeria",
                countryCode: "NG",
            },
        });

        expect(result.decision).toBe("APPROVE");
        expect(result.isValid).toBe(true);
        expect(result.isAllowedDocumentType).toBe(true);
        expect(result.matchedName).toBe(true);
        expect(result.addressDocumentType).toBe("UTILITY_BILL");
    });

    it("routes an address document to review when Nigeria cannot be confirmed", async () => {
        const todayIso = new Date().toISOString().slice(0, 10);
        mockRecognize.mockResolvedValue({
            data: {
                text: `John Doe Utility Bill 10 Main Street Date ${todayIso}`,
                confidence: 94,
            },
        });

        const result = await validateAddressDocument(
            Buffer.from("doc"),
            "John",
            "Doe",
            "10 Main Street",
        );

        expect(result.isValid).toBe(false);
        expect(result.requiresManualReview).toBe(true);
        expect(result.decision).toBe("REVIEW");
        expect(result.reason).toContain(
            "Document country could not be confirmed as Nigeria",
        );
    });

    it("rejects an address document when provider country is not Nigeria", () => {
        const result = combineAddressSignals({
            confidence: 95,
            extractedText: "John Doe Utility Bill 10 Main Street",
            matchedName: true,
            matchedAddress: true,
            matchedResidentialAddress: true,
            addressDocumentType: "UTILITY_BILL",
            documentDate: new Date(),
            providerSignals: {
                documentType: "Utility Bill",
                nameMatches: true,
                documentDate: new Date().toISOString(),
                country: "Ghana",
                countryCode: "GH",
            },
        });

        expect(result.isValid).toBe(false);
        expect(result.requiresManualReview).toBe(false);
        expect(result.decision).toBe("REJECT");
        expect(result.reason).toBe(
            "Only Nigerian proof of address documents are accepted. Please upload a valid Nigerian address document.",
        );
    });

    it("routes conflicting address name signals to manual review", () => {
        const result = combineAddressSignals({
            confidence: 95,
            extractedText: "John Doe Utility Bill",
            matchedName: false,
            matchedAddress: true,
            matchedResidentialAddress: false,
            addressDocumentType: "UTILITY_BILL",
            documentDate: new Date(),
            providerSignals: {
                documentType: "Utility Bill",
                nameMatches: true,
                documentDate: new Date().toISOString(),
                country: "Nigeria",
                countryCode: "NG",
            },
        });

        expect(result.decision).toBe("REVIEW");
        expect(result.requiresManualReview).toBe(true);
        expect(result.reason).toContain(
            "Document owner details could not be confidently confirmed",
        );
    });

    it("should auto-approve a strong address document", async () => {
        const todayIso = new Date().toISOString().slice(0, 10);
        mockRecognize.mockResolvedValue({
            data: {
                text: `John Doe 10 Main Street Lagos Nigeria Electricity Bill Meter Number 12345 Date ${todayIso}`,
                confidence: 95,
            },
        });

        const result = await validateAddressDocument(
            Buffer.from("doc"),
            "John",
            "Doe",
            "10 Main Street Lagos",
        );

        expect(result.isValid).toBe(true);
        expect(result.requiresManualReview).toBe(false);
        expect(result.matchedName).toBe(true);
        expect(result.matchedAddress).toBe(true);
        expect(result.matchedResidentialAddress).toBe(true);
        expect(result.isRecent).toBe(true);
        expect(result.addressDocumentType).toBe("UTILITY_BILL");
        expect(result.isAllowedDocumentType).toBe(true);
    });

    it("should flag address document when extraction is too weak", async () => {
        mockRecognize.mockResolvedValue({
            data: {
                text: "",
                confidence: 8,
            },
        });

        const result = await validateAddressDocument(
            Buffer.from("doc"),
            "John",
            "Doe",
            "10 Main Street Lagos",
        );

        expect(result.isValid).toBe(false);
        expect(result.requiresManualReview).toBe(true);
        expect(result.reason).toContain("Could not extract text from document");
    });

    it("should include detailed reasons for manual address review", async () => {
        const oldDate = new Date();
        oldDate.setMonth(oldDate.getMonth() - 6);
        const oldDateIso = oldDate.toISOString().slice(0, 10);

        mockRecognize.mockResolvedValue({
            data: {
                text: `Payment receipt ${oldDateIso} for Alice Johnson`,
                confidence: 40,
            },
        });

        const result = await validateAddressDocument(
            Buffer.from("doc"),
            "John",
            "Doe",
            "Doe Close Abuja",
        );

        expect(result.isValid).toBe(false);
        expect(result.requiresManualReview).toBe(true);
        expect(result.reason).toContain("Low document quality");
        expect(result.reason).toContain("User name could not be confirmed");
        expect(result.reason).toContain(
            "Address details could not be confirmed",
        );
    });

    it("does not reject solely because the profile residential address text differs", async () => {
        const todayIso = new Date().toISOString().slice(0, 10);
        mockRecognize.mockResolvedValue({
            data: {
                text: `John Doe 99 Broad Street Abuja Nigeria Utility Bill Date ${todayIso}`,
                confidence: 94,
            },
        });

        const result = await validateAddressDocument(
            Buffer.from("doc"),
            "John",
            "Doe",
            "10 Main Street Lagos",
        );

        expect(result.isValid).toBe(true);
        expect(result.matchedResidentialAddress).toBe(false);
        expect(result.reason).toBeUndefined();
    });

    it("should auto-reject a strong address document when the user name is missing", async () => {
        const todayIso = new Date().toISOString().slice(0, 10);
        mockRecognize.mockResolvedValue({
            data: {
                text: `Utility Bill 99 Broad Street Abuja Nigeria Date ${todayIso}`,
                confidence: 94,
            },
        });

        const result = await validateAddressDocument(
            Buffer.from("doc"),
            "John",
            "Doe",
            "10 Main Street Lagos",
        );

        expect(result.isValid).toBe(false);
        expect(result.requiresManualReview).toBe(false);
        expect(result.decision).toBe("REJECT");
        expect(result.reason).toContain("does not carry your name");
    });

    it("should auto-reject an old address document when OCR is otherwise clear", async () => {
        const oldDate = new Date();
        oldDate.setMonth(oldDate.getMonth() - 6);
        const oldDateIso = oldDate.toISOString().slice(0, 10);
        mockRecognize.mockResolvedValue({
            data: {
                text: `John Doe Utility Bill 10 Main Street Lagos Nigeria Date ${oldDateIso}`,
                confidence: 94,
            },
        });

        const result = await validateAddressDocument(
            Buffer.from("doc"),
            "John",
            "Doe",
            "10 Main Street Lagos",
        );

        expect(result.isValid).toBe(false);
        expect(result.requiresManualReview).toBe(false);
        expect(result.decision).toBe("REJECT");
        expect(result.reason).toContain("older than 3 months");
    });

    it("should reject an unsupported address document type", async () => {
        const todayIso = new Date().toISOString().slice(0, 10);
        mockRecognize.mockResolvedValue({
            data: {
                text: `John Doe Employment Reference Letter 10 Main Street Lagos Nigeria Date ${todayIso}`,
                confidence: 94,
            },
        });

        const result = await validateAddressDocument(
            Buffer.from("doc"),
            "John",
            "Doe",
            "10 Main Street Lagos",
        );

        expect(result.isValid).toBe(false);
        expect(result.requiresManualReview).toBe(false);
        expect(result.decision).toBe("REJECT");
        expect(result.matchedAddress).toBe(false);
        expect(result.addressDocumentType).toBeNull();
        expect(result.isAllowedDocumentType).toBe(false);
        expect(result.reason).toBe(
            "Please upload a valid address verification document.",
        );
    });

    it("routes a valid Nigerian bank statement to manual review", async () => {
        const todayIso = new Date().toISOString().slice(0, 10);
        mockRecognize.mockResolvedValue({
            data: {
                text: `John Doe salary payment bank statement amount NGN Date ${todayIso}`,
                confidence: 92,
            },
        });

        const result = await validateIncomeDocument(
            Buffer.from("doc"),
            "John",
            "Doe",
        );

        expect(result.isValid).toBe(false);
        expect(result.requiresManualReview).toBe(true);
        expect(result.decision).toBe("REVIEW");
        expect(result.matchedName).toBe(true);
        expect(result.isRecent).toBe(true);
        expect(result.countryConfirmed).toBe(true);
        expect(result.incomeDocumentType).toBe("BANK_STATEMENT");
        expect(result.isAllowedDocumentType).toBe(true);
    });

    it("uses provider raw text when structured income type and date are missing", async () => {
        const todayIso = new Date().toISOString().slice(0, 10);
        mockRecognize.mockResolvedValue({
            data: {
                text: "John Doe salary payment",
                confidence: 92,
            },
        });

        const result = await validateIncomeDocument(
            Buffer.from("doc"),
            "John",
            "Doe",
            undefined,
            {
                isValid: true,
                reason: "VALID",
                documentType: "",
                rawText: `Statement of Account\nJohn Doe\nNGN Lagos Nigeria\nStatement Date ${todayIso}`,
                nameMatches: true,
                countryCode: "NG",
            },
        );

        expect(result.isValid).toBe(false);
        expect(result.requiresManualReview).toBe(true);
        expect(result.decision).toBe("REVIEW");
        expect(result.incomeDocumentType).toBe("BANK_STATEMENT");
        expect(result.documentDate).toBeDefined();
        expect(result.isRecent).toBe(true);
        expect(result.countryConfirmed).toBe(true);
        expect(result.providerVerified).toBe(true);
    });

    it("routes provider-valid Nigerian bank statements with no extractable date to review", async () => {
        mockRecognize.mockResolvedValue({
            data: {
                text: "John Doe bank statement salary credit NGN Lagos Nigeria",
                confidence: 92,
            },
        });

        const result = await validateIncomeDocument(
            Buffer.from("doc"),
            "John",
            "Doe",
            undefined,
            {
                isValid: true,
                reason: "VALID",
                documentType: "",
                rawText:
                    "Income ReadyUser 12 Idowu Taylor Street Victoria Island Lagos Nigeria",
                nameMatches: true,
                countryCode: "NG",
            },
        );

        expect(result.isValid).toBe(false);
        expect(result.requiresManualReview).toBe(true);
        expect(result.decision).toBe("REVIEW");
        expect(result.incomeDocumentType).toBe("BANK_STATEMENT");
        expect(result.documentDate).toBeUndefined();
        expect(result.isRecent).toBe(false);
        expect(result.reason).toContain("statement date");
    });

    it("recognizes major Nigerian banks as country hints for income statements", async () => {
        const todayIso = new Date().toISOString().slice(0, 10);
        mockRecognize.mockResolvedValue({
            data: {
                text: `Stanbic IBTC Bank statement of account John Doe salary payment Date ${todayIso}`,
                confidence: 92,
            },
        });

        const result = await validateIncomeDocument(
            Buffer.from("doc"),
            "John",
            "Doe",
        );

        expect(result.decision).toBe("REVIEW");
        expect(result.countryConfirmed).toBe(true);
        expect(result.incomeDocumentType).toBe("BANK_STATEMENT");
        expect(result.reason).not.toBe(
            "Please upload a valid Nigerian bank statement.",
        );
    });

    it("uses provider raw text when structured address type and date are missing", async () => {
        const todayIso = new Date().toISOString().slice(0, 10);
        mockRecognize.mockResolvedValue({
            data: {
                text: "John Doe 10 Main Street",
                confidence: 92,
            },
        });

        const result = await validateAddressDocument(
            Buffer.from("doc"),
            "John",
            "Doe",
            "10 Main Street Lagos",
            undefined,
            {
                isValid: true,
                reason: "VALID",
                documentType: "",
                rawText: `Utility Bill\nJohn Doe\n10 Main Street Lagos Nigeria\nStatement Date ${todayIso}`,
                nameMatches: true,
                countryCode: "NG",
            },
        );

        expect(result.isValid).toBe(true);
        expect(result.decision).toBe("APPROVE");
        expect(result.addressDocumentType).toBe("UTILITY_BILL");
        expect(result.documentDate).toBeDefined();
        expect(result.isRecent).toBe(true);
        expect(result.countryConfirmed).toBe(true);
        expect(result.providerVerified).toBe(true);
    });

    it("rejects an income document that is not a bank statement", async () => {
        const todayIso = new Date().toISOString().slice(0, 10);
        mockRecognize.mockResolvedValue({
            data: {
                text: `John Doe utility document Date ${todayIso}`,
                confidence: 85,
            },
        });

        const result = await validateIncomeDocument(
            Buffer.from("doc"),
            "John",
            "Doe",
        );

        expect(result.isValid).toBe(false);
        expect(result.requiresManualReview).toBe(false);
        expect(result.decision).toBe("REJECT");
        expect(result.reason).toContain("Only bank statements are accepted");
    });

    it("rejects a bank statement when the profile name does not match", async () => {
        const todayIso = new Date().toISOString().slice(0, 10);
        mockRecognize.mockResolvedValue({
            data: {
                text: `Jane Doe bank statement debit credit NGN Date ${todayIso}`,
                confidence: 88,
            },
        });

        const result = await validateIncomeDocument(
            Buffer.from("doc"),
            "John",
            "Doe",
        );

        expect(result.isValid).toBe(false);
        expect(result.requiresManualReview).toBe(false);
        expect(result.decision).toBe("REJECT");
        expect(result.reason).toContain(
            "does not match the name on your profile",
        );
    });

    it("rejects a bank statement when Nigeria cannot be confirmed", async () => {
        const todayIso = new Date().toISOString().slice(0, 10);
        mockRecognize.mockResolvedValue({
            data: {
                text: `John Doe bank statement debit credit account Date ${todayIso}`,
                confidence: 90,
            },
        });

        const result = await validateIncomeDocument(
            Buffer.from("doc"),
            "John",
            "Doe",
        );

        expect(result.isValid).toBe(false);
        expect(result.requiresManualReview).toBe(false);
        expect(result.decision).toBe("REJECT");
        expect(result.reason).toBe(
            "Please upload a valid Nigerian bank statement.",
        );
    });

    it("rejects an income document older than 3 months", async () => {
        const oldDate = new Date();
        oldDate.setMonth(oldDate.getMonth() - 6);
        const oldDateIso = oldDate.toISOString().slice(0, 10);
        mockRecognize.mockResolvedValue({
            data: {
                text: `John Doe bank statement NGN credit debit Lagos Date ${oldDateIso}`,
                confidence: 91,
            },
        });

        const result = await validateIncomeDocument(
            Buffer.from("doc"),
            "John",
            "Doe",
        );

        expect(result.isValid).toBe(false);
        expect(result.requiresManualReview).toBe(false);
        expect(result.decision).toBe("REJECT");
        expect(result.reason).toContain("older than 3 months");
    });

    it("rejects a bank statement when provider analysis flags it as a copied or fake document", async () => {
        const todayIso = new Date().toISOString().slice(0, 10);
        mockRecognize.mockResolvedValue({
            data: {
                text: `John Doe bank statement salary credit NGN Lagos Date ${todayIso}`,
                confidence: 93,
            },
        });

        const result = await validateIncomeDocument(
            Buffer.from("doc"),
            "John",
            "Doe",
            undefined,
            {
                isValid: false,
                reason: "Printed photocopy detected",
                documentType: "Bank Statement",
                nameMatches: true,
                documentDate: todayIso,
                country: "Nigeria",
                countryCode: "NG",
            },
        );

        expect(result.isValid).toBe(false);
        expect(result.requiresManualReview).toBe(false);
        expect(result.decision).toBe("REJECT");
        expect(result.providerVerified).toBe(false);
        expect(result.providerReason).toBe("Printed photocopy detected");
        expect(result.reason).toBe(
            "This bank statement could not be verified as an original document. Please upload an original Nigerian bank statement that shows your full name.",
        );
    });
});
