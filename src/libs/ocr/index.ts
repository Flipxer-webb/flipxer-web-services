/**
 * OCR Service using Tesseract.js
 * Extracts text from documents for validation of address and income documents
 */

import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Tesseract from "tesseract.js";
import { Logger } from "@nestjs/common";
import {
    jaroWinklerSimilarity,
    normaliseName,
} from "@/utils/name-matcher";

const logger = new Logger("OCRService");

// Minimum confidence threshold for auto-approval
const MIN_CONFIDENCE_THRESHOLD = 70;

// Maximum age of a document for auto-approval (in months)
const RECENCY_MONTHS = 3;

// Jaro-Winkler threshold for name matching (consistent with BVN/NIN flow)
const NAME_MATCH_THRESHOLD = 0.85;

const PDF_FILE_SIGNATURE = "%PDF";
const MAX_PDF_PAGES_FOR_OCR = 3;
const PDF_RASTERIZE_STDIO_LIMIT = 10 * 1024 * 1024;
const PDFTOPPM_BINARY_PATH = "/usr/bin/pdftoppm";

export interface OCRResult {
    text: string;
    confidence: number;
}

export class OcrDocumentPreparationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "OcrDocumentPreparationError";
    }
}

export interface DocumentValidationResult {
    isValid: boolean;
    confidence: number;
    extractedText: string;
    matchedName: boolean;
    matchedAddress?: boolean;
    matchedResidentialAddress?: boolean | null;
    requiresManualReview: boolean;
    reason?: string;
    /** Most recent date found in document (ISO format), if any */
    documentDate?: string;
    /** Whether the document date is within the recency window */
    isRecent?: boolean;
}

/**
 * Extract text from a document image or PDF
 * @param imageBuffer - Buffer containing the image data
 * @returns OCRResult with extracted text and confidence score
 */
function isPdfDocument(documentBuffer: Buffer, mimeType?: string): boolean {
    if (mimeType?.toLowerCase().includes("pdf")) {
        return true;
    }

    return documentBuffer.subarray(0, PDF_FILE_SIGNATURE.length).toString("utf8") === PDF_FILE_SIGNATURE;
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function rasterizePdfToImages(documentBuffer: Buffer, outputPrefix: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = spawn(
            PDFTOPPM_BINARY_PATH,
            ["-png", "-f", "1", "-l", String(MAX_PDF_PAGES_FOR_OCR), "-", outputPrefix],
            { stdio: ["pipe", "pipe", "pipe"] },
        );
        let settled = false;
        let stdoutSize = 0;
        let stderrSize = 0;
        let stderr = "";

        const settle = (handler: () => void) => {
            if (settled) {
                return;
            }

            settled = true;
            handler();
        };

        const fail = (error: Error) => {
            settle(() => reject(error));
        };

        child.stdout?.on("data", (chunk: Buffer | string) => {
            stdoutSize += Buffer.byteLength(chunk);

            if (stdoutSize > PDF_RASTERIZE_STDIO_LIMIT) {
                child.kill();
                fail(new Error("pdftoppm stdout exceeded limit"));
            }
        });

        child.stderr?.on("data", (chunk: Buffer | string) => {
            const text = chunk.toString();

            stderr += text;
            stderrSize += Buffer.byteLength(text);

            if (stderrSize > PDF_RASTERIZE_STDIO_LIMIT) {
                child.kill();
                fail(new Error("pdftoppm stderr exceeded limit"));
            }
        });

        child.once("error", fail);
        child.once("close", (code) => {
            if (code === 0) {
                settle(resolve);
                return;
            }

            fail(new Error(stderr || `pdftoppm exited with code ${code ?? "unknown"}`));
        });
        child.stdin?.once("error", fail);
        child.stdin?.end(documentBuffer);
    });
}

async function rasterizePdfPages(documentBuffer: Buffer): Promise<Buffer[]> {
    const tempDir = await mkdtemp(join(tmpdir(), "flipxer-pdf-ocr-"));
    const outputPrefix = join(tempDir, "page");

    try {
        await rasterizePdfToImages(documentBuffer, outputPrefix);

        const rasterizedPages: Buffer[] = [];

        for (let pageIndex = 1; pageIndex <= MAX_PDF_PAGES_FOR_OCR; pageIndex += 1) {
            const pagePath = `${outputPrefix}-${pageIndex}.png`;
            if (!(await fileExists(pagePath))) {
                break;
            }

            rasterizedPages.push(await readFile(pagePath));
        }

        if (rasterizedPages.length === 0) {
            throw new Error("PDF rasterization produced no images");
        }

        return rasterizedPages;
    } catch (error) {
        if (error instanceof OcrDocumentPreparationError) {
            throw error;
        }

        logger.error("PDF rasterization failed:", error);
        throw new OcrDocumentPreparationError(
            "Unsupported or unreadable PDF document. Please upload a valid PDF or image file.",
        );
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
}

async function recognizeDocumentImage(imageBuffer: Buffer): Promise<OCRResult> {
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
}

export async function extractTextFromDocument(
    imageBuffer: Buffer,
    mimeType?: string,
): Promise<OCRResult> {
    try {
        const ocrInputs = isPdfDocument(imageBuffer, mimeType)
            ? await rasterizePdfPages(imageBuffer)
            : [imageBuffer];
        const results: OCRResult[] = [];

        for (const ocrInput of ocrInputs) {
            results.push(await recognizeDocumentImage(ocrInput));
        }

        return {
            text: results
                .map((result) => result.text.trim())
                .filter(Boolean)
                .join("\n\n"),
            confidence:
                results.length > 0
                    ? results.reduce((sum, result) => sum + result.confidence, 0) / results.length
                    : 0,
        };
    } catch (error) {
        if (error instanceof OcrDocumentPreparationError) {
            throw error;
        }

        logger.error("OCR extraction failed:", error);
        return {
            text: "",
            confidence: 0,
        };
    }
}

/**
 * Normalize a string for text comparison
 * Removes special characters, extra spaces, converts to lowercase
 */
function normalizeString(str: string): string {
    return str
        .toLowerCase()
        .replaceAll(/[^a-z0-9\s]/g, "")
        .replaceAll(/\s+/g, " ")
        .trim();
}

/**
 * Check if a name appears in the extracted text using Jaro-Winkler fuzzy matching.
 *
 * Strategy:
 *   1. Exact substring match for full name (first+last or last+first)
 *   2. Both first AND last name found separately as substrings
 *   3. Jaro-Winkler fuzzy match — requires BOTH first and last name
 *      to exceed the 0.85 threshold against individual words in the text
 *
 * @param extractedText - Text extracted from document via OCR
 * @param firstName - User's first name (from database)
 * @param lastName - User's last name (from database)
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

    // Guard: if either name is empty, can't match
    if (!normalizedFirst || !normalizedLast) {
        return false;
    }

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

    // Jaro-Winkler fuzzy match: require BOTH names to match above threshold
    const words = normalizedText.split(" ");
    let bestFirstScore = 0;
    let bestLastScore = 0;

    for (const word of words) {
        if (word.length >= 2) {
            const firstScore = jaroWinklerSimilarity(
                normaliseName(word),
                normaliseName(normalizedFirst)
            );
            const lastScore = jaroWinklerSimilarity(
                normaliseName(word),
                normaliseName(normalizedLast)
            );
            bestFirstScore = Math.max(bestFirstScore, firstScore);
            bestLastScore = Math.max(bestLastScore, lastScore);
        }
    }

    // Both first and last name must fuzzy-match
    if (bestFirstScore >= NAME_MATCH_THRESHOLD && bestLastScore >= NAME_MATCH_THRESHOLD) {
        return true;
    }

    return false;
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

function checkResidentialAddressMatch(
    extractedText: string,
    residentialAddress?: string | null,
): boolean | null {
    const normalizedAddress = normalizeString(residentialAddress || "");
    if (!normalizedAddress) {
        return null;
    }

    const normalizedText = normalizeString(extractedText);
    if (normalizedText.includes(normalizedAddress)) {
        return true;
    }

    const addressTokens = normalizedAddress
        .split(" ")
        .filter((token) => token.length >= 3);

    if (addressTokens.length === 0) {
        return false;
    }

    const matchedTokens = addressTokens.filter((token) => normalizedText.includes(token));
    return matchedTokens.length >= Math.max(2, Math.ceil(addressTokens.length * 0.6));
}

// ───────────────────── Document Recency ─────────────────────

const MONTH_MAP: Record<string, number> = {
    jan: 0, january: 0,
    feb: 1, february: 1,
    mar: 2, march: 2,
    apr: 3, april: 3,
    may: 4,
    jun: 5, june: 5,
    jul: 6, july: 6,
    aug: 7, august: 7,
    sep: 8, september: 8,
    oct: 9, october: 9,
    nov: 10, november: 10,
    dec: 11, december: 11,
};

/**
 * Extract dates from OCR text and return the most recent valid one.
 * Supports formats:
 *   - DD/MM/YYYY or DD-MM-YYYY
 *   - YYYY-MM-DD (ISO)
 *   - "15 January 2025" or "January 15, 2025"
 *
 * Only returns dates that are plausible (year 2000-2099, valid month/day).
 */
export function extractDocumentDate(text: string): Date | null {
    const dates: Date[] = [];

    const tryAddDate = (year: number, month: number, day: number) => {
        if (year < 2000 || year > 2099) return;
        if (month < 0 || month > 11) return;
        if (day < 1 || day > 31) return;
        const d = new Date(year, month, day);
        // Verify the date didn't overflow (e.g. Feb 30 → Mar 2)
        if (d.getFullYear() === year && d.getMonth() === month && d.getDate() === day) {
            dates.push(d);
        }
    };

    // Pattern 1: DD/MM/YYYY or DD-MM-YYYY
    const dmyRegex = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/g;
    let match: RegExpExecArray | null;
    while ((match = dmyRegex.exec(text)) !== null) {
        const day = Number.parseInt(match[1], 10);
        const month = Number.parseInt(match[2], 10) - 1; // 0-indexed
        const year = Number.parseInt(match[3], 10);
        tryAddDate(year, month, day);
    }

    // Pattern 2: YYYY-MM-DD (ISO) — only match if not already captured by DMY
    const isoRegex = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
    while ((match = isoRegex.exec(text)) !== null) {
        const year = Number.parseInt(match[1], 10);
        const month = Number.parseInt(match[2], 10) - 1;
        const day = Number.parseInt(match[3], 10);
        tryAddDate(year, month, day);
    }

    // Pattern 3: "DD Month YYYY" (e.g. "15 January 2025")
    // Use broad [a-z]+ match — MONTH_MAP lookup validates the month name
    const dMyRegex = /\b(\d{1,2})\s+([a-z]+)\s+(\d{4})\b/gi;
    while ((match = dMyRegex.exec(text)) !== null) {
        const day = Number.parseInt(match[1], 10);
        const monthStr = match[2].toLowerCase();
        const year = Number.parseInt(match[3], 10);
        const month = MONTH_MAP[monthStr];
        if (month !== undefined) {
            tryAddDate(year, month, day);
        }
    }

    // Pattern 4: "Month DD, YYYY" (e.g. "January 15, 2025")
    // Use broad [a-z]+ match — MONTH_MAP lookup validates the month name
    const mDyRegex = /\b([a-z]+)\s+(\d{1,2}),?\s+(\d{4})\b/gi;
    while ((match = mDyRegex.exec(text)) !== null) {
        const monthStr = match[1].toLowerCase();
        const day = Number.parseInt(match[2], 10);
        const year = Number.parseInt(match[3], 10);
        const month = MONTH_MAP[monthStr];
        if (month !== undefined) {
            tryAddDate(year, month, day);
        }
    }

    if (dates.length === 0) return null;

    // Return the most recent date
    dates.sort((a, b) => b.getTime() - a.getTime());
    return dates[0];
}

/**
 * Check if a document date is within the recency window.
 * Returns false if no date is provided (conservative: treat undated documents as not recent).
 */
export function isDocumentRecent(documentDate: Date | null): boolean {
    if (!documentDate) return false;
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - RECENCY_MONTHS);
    return documentDate >= cutoff;
}

// ───────────────────── Document Validators ─────────────────────

/**
 * Validate an address document
 * @param imageBuffer - Document image buffer
 * @param firstName - User's first name (from database)
 * @param lastName - User's last name (from database)
 * @returns DocumentValidationResult with validation details
 */
export async function validateAddressDocument(
    imageBuffer: Buffer,
    firstName: string,
    lastName: string,
    residentialAddress?: string | null,
    mimeType?: string,
): Promise<DocumentValidationResult> {
    const ocrResult = await extractTextFromDocument(imageBuffer, mimeType);

    if (!ocrResult.text || ocrResult.confidence < 10) {
        return {
            isValid: false,
            confidence: ocrResult.confidence,
            extractedText: ocrResult.text,
            matchedName: false,
            matchedAddress: false,
            matchedResidentialAddress: null,
            requiresManualReview: true,
            reason: "Could not extract text from document. Please upload a clearer image.",
        };
    }

    const matchedName = checkNameInText(ocrResult.text, firstName, lastName);
    const matchedAddress = checkAddressIndicators(ocrResult.text);
    const matchedResidentialAddress = checkResidentialAddressMatch(ocrResult.text, residentialAddress);
    const docDate = extractDocumentDate(ocrResult.text);
    const recent = isDocumentRecent(docDate);

    // Determine if manual review is needed
    const requiresManualReview =
        ocrResult.confidence < MIN_CONFIDENCE_THRESHOLD ||
        !matchedName ||
        !matchedAddress ||
        matchedResidentialAddress === false ||
        !recent;

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
        if (matchedResidentialAddress === false) {
            issues.push("Residential address does not match the profile address");
        }
        if (!recent) {
            issues.push(
                docDate
                    ? "Document appears to be older than 3 months"
                    : "Document date not found"
            );
        }
        reason = `Document flagged for review: ${issues.join(", ")}`;
    }

    return {
        isValid: !requiresManualReview,
        confidence: ocrResult.confidence,
        extractedText: ocrResult.text,
        matchedName,
        matchedAddress,
        matchedResidentialAddress,
        requiresManualReview,
        reason,
        documentDate: docDate?.toISOString(),
        isRecent: recent,
    };
}

/**
 * Validate an income document (payslip, bank statement, tax document)
 * @param imageBuffer - Document image buffer
 * @param firstName - User's first name (from database)
 * @param lastName - User's last name (from database)
 * @returns DocumentValidationResult with validation details
 */
export async function validateIncomeDocument(
    imageBuffer: Buffer,
    firstName: string,
    lastName: string,
    mimeType?: string,
): Promise<DocumentValidationResult> {
    const ocrResult = await extractTextFromDocument(imageBuffer, mimeType);

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
    const docDate = extractDocumentDate(ocrResult.text);
    const recent = isDocumentRecent(docDate);

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
        !hasIncomeIndicators ||
        !recent;

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
        if (!recent) {
            issues.push(
                docDate
                    ? "Document appears to be older than 3 months"
                    : "Document date not found"
            );
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
        documentDate: docDate?.toISOString(),
        isRecent: recent,
    };
}
