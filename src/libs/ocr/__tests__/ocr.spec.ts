import {
    checkNameInText,
    extractDocumentDate,
    isDocumentRecent,
} from "../index";

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
