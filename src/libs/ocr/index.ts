/**
 * OCR Service using Tesseract.js
 * Extracts text from documents for validation of address and income documents
 */

import Tesseract from "tesseract.js";
import { Logger } from "@nestjs/common";

const logger = new Logger("OCRService");

export interface OCRResult {
    text: string;
    confidence: number;
}

export interface DocumentValidationResult {
    isValid: boolean;
    confidence: number;
    extractedText: string;
    matchedName: boolean;
    matchedAddress?: boolean;
    requiresManualReview: boolean;
    reason?: string;
}

// Minimum confidence threshold for auto-approval
const MIN_CONFIDENCE_THRESHOLD = 70;

/**
 * Extract text from a document image or PDF
 * @param imageBuffer - Buffer containing the image data
 * @returns OCRResult with extracted text and confidence score
 */
export async function extractTextFromDocument(
    imageBuffer: Buffer
): Promise<OCRResult> {
    try {
        const result = await Tesseract.recognize(imageBuffer, "eng", {
            logger: (m) => {
                if (m.status === "recognizing text" && m.progress === 1) {
                    logger.debug(`OCR complete`);
                }
            },
        });

        return {
            text: result.data.text,
            confidence: result.data.confidence,
        };
    } catch (error) {
        logger.error("OCR extraction failed:", error);
        return {
            text: "",
            confidence: 0,
        };
    }
}

/**
 * Normalize a string for fuzzy matching
 * Removes special characters, extra spaces, converts to lowercase
 */
function normalizeString(str: string): string {
    return str
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Check if a name appears in the extracted text using fuzzy matching
 * @param extractedText - Text extracted from document via OCR
 * @param firstName - User's first name
 * @param lastName - User's last name
 * @returns true if the name is found in the text
 */
export function checkNameInText(
    extractedText: string,
    firstName: string,
    lastName: string
): boolean {
    const normalizedText = normalizeString(extractedText);
    const normalizedFirst = normalizeString(firstName);
    const normalizedLast = normalizeString(lastName);

    // Check for full name (first + last)
    const fullName = `${normalizedFirst} ${normalizedLast}`;
    if (normalizedText.includes(fullName)) {
        return true;
    }

    // Check for reversed name (last + first)
    const reversedName = `${normalizedLast} ${normalizedFirst}`;
    if (normalizedText.includes(reversedName)) {
        return true;
    }

    // Check if both first and last names appear separately
    const hasFirstName = normalizedText.includes(normalizedFirst);
    const hasLastName = normalizedText.includes(normalizedLast);

    // Require both names to be present if checking separately
    if (hasFirstName && hasLastName) {
        return true;
    }

    // Fuzzy match: check if 80% of characters match
    const words = normalizedText.split(" ");
    for (const word of words) {
        if (word.length >= 3) {
            if (
                levenshteinDistance(word, normalizedFirst) <= 2 ||
                levenshteinDistance(word, normalizedLast) <= 2
            ) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Calculate Levenshtein distance between two strings
 * Used for fuzzy name matching
 */
function levenshteinDistance(a: string, b: string): number {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix: number[][] = [];

    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }

    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1, // substitution
                    matrix[i][j - 1] + 1, // insertion
                    matrix[i - 1][j] + 1 // deletion
                );
            }
        }
    }

    return matrix[b.length][a.length];
}

/**
 * Check if an address-related document contains address indicators
 * @param extractedText - Text extracted from document via OCR
 * @returns true if address-related keywords are found
 */
export function checkAddressIndicators(extractedText: string): boolean {
    const normalizedText = normalizeString(extractedText);

    // Common address-related keywords
    const addressKeywords = [
        "street",
        "road",
        "avenue",
        "lane",
        "drive",
        "close",
        "crescent",
        "estate",
        "apartment",
        "flat",
        "house",
        "building",
        "floor",
        "block",
        "plot",
        "address",
        "residence",
        "city",
        "state",
        "lagos",
        "abuja",
        "nigeria",
        // Utility bill keywords
        "electricity",
        "water",
        "gas",
        "bill",
        "invoice",
        "statement",
        "account",
        "meter",
        "phcn",
        "ekedc",
        "ikedc",
        "aedc",
        "bank",
    ];

    const matchedKeywords = addressKeywords.filter((keyword) =>
        normalizedText.includes(keyword)
    );

    // Require at least 2 address-related keywords
    return matchedKeywords.length >= 2;
}

/**
 * Validate an address document
 * @param imageBuffer - Document image buffer
 * @param firstName - User's first name
 * @param lastName - User's last name
 * @returns DocumentValidationResult with validation details
 */
export async function validateAddressDocument(
    imageBuffer: Buffer,
    firstName: string,
    lastName: string
): Promise<DocumentValidationResult> {
    const ocrResult = await extractTextFromDocument(imageBuffer);

    if (!ocrResult.text || ocrResult.confidence < 10) {
        return {
            isValid: false,
            confidence: ocrResult.confidence,
            extractedText: ocrResult.text,
            matchedName: false,
            matchedAddress: false,
            requiresManualReview: true,
            reason: "Could not extract text from document. Please upload a clearer image.",
        };
    }

    const matchedName = checkNameInText(ocrResult.text, firstName, lastName);
    const matchedAddress = checkAddressIndicators(ocrResult.text);

    // Determine if manual review is needed
    const requiresManualReview =
        ocrResult.confidence < MIN_CONFIDENCE_THRESHOLD ||
        !matchedName ||
        !matchedAddress;

    let reason: string | undefined;
    if (requiresManualReview) {
        const issues: string[] = [];
        if (ocrResult.confidence < MIN_CONFIDENCE_THRESHOLD) {
            issues.push("Low document quality");
        }
        if (!matchedName) {
            issues.push("Name not clearly visible");
        }
        if (!matchedAddress) {
            issues.push("Address not clearly visible");
        }
        reason = `Document flagged for review: ${issues.join(", ")}`;
    }

    return {
        isValid: !requiresManualReview,
        confidence: ocrResult.confidence,
        extractedText: ocrResult.text,
        matchedName,
        matchedAddress,
        requiresManualReview,
        reason,
    };
}

/**
 * Validate an income document (payslip, bank statement, tax document)
 * @param imageBuffer - Document image buffer
 * @param firstName - User's first name
 * @param lastName - User's last name
 * @returns DocumentValidationResult with validation details
 */
export async function validateIncomeDocument(
    imageBuffer: Buffer,
    firstName: string,
    lastName: string
): Promise<DocumentValidationResult> {
    const ocrResult = await extractTextFromDocument(imageBuffer);

    if (!ocrResult.text || ocrResult.confidence < 10) {
        return {
            isValid: false,
            confidence: ocrResult.confidence,
            extractedText: ocrResult.text,
            matchedName: false,
            requiresManualReview: true,
            reason: "Could not extract text from document. Please upload a clearer image.",
        };
    }

    const matchedName = checkNameInText(ocrResult.text, firstName, lastName);

    // Check for income-related keywords
    const normalizedText = normalizeString(ocrResult.text);
    const incomeKeywords = [
        "salary",
        "income",
        "payment",
        "wages",
        "earnings",
        "payslip",
        "pay slip",
        "bank statement",
        "statement",
        "credit",
        "debit",
        "balance",
        "transaction",
        "account",
        "employer",
        "employee",
        "gross",
        "net",
        "tax",
        "paye",
        "pension",
        "naira",
        "ngn",
        "amount",
    ];

    const matchedIncomeKeywords = incomeKeywords.filter((keyword) =>
        normalizedText.includes(keyword)
    );

    const hasIncomeIndicators = matchedIncomeKeywords.length >= 2;

    // Determine if manual review is needed
    const requiresManualReview =
        ocrResult.confidence < MIN_CONFIDENCE_THRESHOLD ||
        !matchedName ||
        !hasIncomeIndicators;

    let reason: string | undefined;
    if (requiresManualReview) {
        const issues: string[] = [];
        if (ocrResult.confidence < MIN_CONFIDENCE_THRESHOLD) {
            issues.push("Low document quality");
        }
        if (!matchedName) {
            issues.push("Name not clearly visible");
        }
        if (!hasIncomeIndicators) {
            issues.push("Income information not clearly visible");
        }
        reason = `Document flagged for review: ${issues.join(", ")}`;
    }

    return {
        isValid: !requiresManualReview,
        confidence: ocrResult.confidence,
        extractedText: ocrResult.text,
        matchedName,
        requiresManualReview,
        reason,
    };
}
