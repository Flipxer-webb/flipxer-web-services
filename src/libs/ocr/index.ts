/**
 * OCR Service using Tesseract.js
 * Extracts text from documents for validation of address and income documents
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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

export type AddressDocumentType = "UTILITY_BILL" | "BANK_STATEMENT" | "GOVERNMENT_LETTER";
export type IncomeDocumentType = "BANK_STATEMENT";

export interface AddressProviderSignals {
    documentType?: string | null;
    rawText?: string | null;
    nameMatches?: boolean | null;
    documentDate?: string | null;
    country?: string | null;
    countryCode?: string | null;
    isValid?: boolean | null;
    reason?: string | null;
    providerInteraction?: {
        provider: string;
        request: Record<string, unknown>;
        response?: Record<string, unknown> | null;
        error?: Record<string, unknown> | null;
    } | null;
}

export interface IncomeProviderSignals {
    documentType?: string | null;
    rawText?: string | null;
    nameMatches?: boolean | null;
    documentDate?: string | null;
    country?: string | null;
    countryCode?: string | null;
    isValid?: boolean | null;
    reason?: string | null;
    providerInteraction?: {
        provider: string;
        request: Record<string, unknown>;
        response?: Record<string, unknown> | null;
        error?: Record<string, unknown> | null;
    } | null;
}

type DocumentValidationDecision = "APPROVE" | "REJECT" | "REVIEW";

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
    addressDocumentType?: AddressDocumentType | null;
    incomeDocumentType?: IncomeDocumentType | null;
    isAllowedDocumentType?: boolean;
    requiresManualReview: boolean;
    decision?: DocumentValidationDecision;
    reason?: string;
    /** Most recent date found in document (ISO format), if any */
    documentDate?: string;
    /** Whether the document date is within the recency window */
    isRecent?: boolean;
    countryConfirmed?: boolean;
    providerDocumentType?: string | null;
    providerNameMatches?: boolean | null;
    providerDocumentDate?: string | null;
    providerCountry?: string | null;
    providerCountryCode?: string | null;
    providerVerified?: boolean | null;
    providerReason?: string | null;
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
        const generatedFiles = new Set(await readdir(tempDir));

        for (let pageIndex = 1; pageIndex <= MAX_PDF_PAGES_FOR_OCR; pageIndex += 1) {
            const pageFileName = `page-${pageIndex}.png`;
            if (!generatedFiles.has(pageFileName)) {
                break;
            }

            rasterizedPages.push(await readFile(join(tempDir, pageFileName)));
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

export async function prepareDocumentForProviderAnalysis(
    documentBuffer: Buffer,
    mimeType?: string,
): Promise<Buffer> {
    if (!isPdfDocument(documentBuffer, mimeType)) {
        return documentBuffer;
    }

    const rasterizedPages = await rasterizePdfPages(documentBuffer);

    return rasterizedPages[0];
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
    return detectAddressDocumentType(extractedText) !== null;
}

export function detectAddressDocumentType(extractedText: string): AddressDocumentType | null {
    const normalizedText = normalizeString(extractedText);

    const hasAny = (keywords: string[]): boolean => keywords.some((keyword) => normalizedText.includes(keyword));

    const utilityBillKeywords = [
        "utility bill",
        "electricity bill",
        "water bill",
        "gas bill",
        "bill",
        "invoice",
    ];
    const utilityProviderKeywords = [
        "electricity",
        "water",
        "gas",
        "meter",
        "phcn",
        "ekedc",
        "ikedc",
        "aedc",
        "bedc",
        "ibedc",
        "eedc",
        "kedco",
        "kaedco",
        "jed",
        "yedc",
    ];

    if (hasAny(["utility bill", "electricity bill", "water bill", "gas bill"])) {
        return "UTILITY_BILL";
    }

    if (hasAny(utilityBillKeywords) && hasAny(utilityProviderKeywords)) {
        return "UTILITY_BILL";
    }

    const bankStatementKeywords = ["bank statement", "statement of account"];
    const bankEvidenceKeywords = ["bank", "account", "transaction", "debit", "credit", "balance"];

    if (hasAny(bankStatementKeywords)) {
        return "BANK_STATEMENT";
    }

    if (normalizedText.includes("statement") && hasAny(bankEvidenceKeywords)) {
        return "BANK_STATEMENT";
    }

    const governmentKeywords = [
        "government",
        "federal republic of nigeria",
        "state government",
        "local government",
        "ministry",
        "agency",
        "commission",
        "council",
        "parastatal",
        "secretariat",
    ];
    const governmentLetterKeywords = [
        "government letter",
        "official letter",
        "letterhead",
        "to whom it may concern",
        "dear sir",
        "dear madam",
    ];

    if (hasAny(governmentLetterKeywords)) {
        return "GOVERNMENT_LETTER";
    }

    if (hasAny(governmentKeywords) && hasAny(["letter", "reference", "ref", "official"])) {
        return "GOVERNMENT_LETTER";
    }

    return null;
}

function normalizeAddressProviderDocumentType(documentType?: string | null): AddressDocumentType | null {
    const normalizedType = normalizeString(documentType || "");

    if (!normalizedType) {
        return null;
    }

    if (
        normalizedType.includes("utility")
        || normalizedType.includes("electricity bill")
        || normalizedType.includes("water bill")
        || normalizedType.includes("gas bill")
        || normalizedType.includes("bill")
    ) {
        return "UTILITY_BILL";
    }

    if (
        normalizedType.includes("bank statement")
        || (normalizedType.includes("bank") && normalizedType.includes("statement"))
        || normalizedType.includes("statement of account")
    ) {
        return "BANK_STATEMENT";
    }

    if (
        normalizedType.includes("government")
        || normalizedType.includes("official letter")
        || normalizedType.includes("letterhead")
        || normalizedType.includes("ministry")
        || normalizedType.includes("agency")
        || normalizedType.includes("commission")
    ) {
        return "GOVERNMENT_LETTER";
    }

    return null;
}

function detectIncomeDocumentType(extractedText: string): IncomeDocumentType | null {
    return detectAddressDocumentType(extractedText) === "BANK_STATEMENT"
        ? "BANK_STATEMENT"
        : null;
}

function normalizeIncomeProviderDocumentType(documentType?: string | null): IncomeDocumentType | null {
    return normalizeAddressProviderDocumentType(documentType) === "BANK_STATEMENT"
        ? "BANK_STATEMENT"
        : null;
}

function parseDocumentDateValue(documentDate?: string | null): Date | null {
    if (!documentDate) {
        return null;
    }

    const parsedDate = new Date(documentDate);
    if (!Number.isNaN(parsedDate.getTime())) {
        return parsedDate;
    }

    return extractDocumentDate(documentDate);
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

function buildAddressReviewReason(params: {
    confidence: number;
    matchedName: boolean;
    matchedAddress: boolean;
    documentDate: Date | null;
    hasNameConflict?: boolean;
    hasDocumentDateConflict?: boolean;
    hasUnconfirmedCountry?: boolean;
}): string {
    const issues: string[] = [];

    if (params.confidence < MIN_CONFIDENCE_THRESHOLD) {
        issues.push("Low document quality");
    }

    if (params.hasNameConflict) {
        issues.push("Document owner details could not be confidently confirmed");
    } else if (!params.matchedName) {
        issues.push("User name could not be confirmed");
    }

    if (!params.matchedAddress) {
        issues.push("Address details could not be confirmed");
    }

    if (params.hasUnconfirmedCountry) {
        issues.push("Document country could not be confirmed as Nigeria");
    }

    if (params.hasDocumentDateConflict || !params.documentDate) {
        issues.push("Document date could not be confirmed");
    }

    return `Document flagged for review: ${issues.join(", ")}`;
}

function buildAddressRejectReason(params: {
    matchedName: boolean;
    matchedAddress: boolean;
    documentDate: Date | null;
    isRecent: boolean;
}): string | null {
    if (!params.matchedName) {
        return "The submitted address document does not carry your name. Please upload a recent proof of address that shows your full name.";
    }

    if (!params.matchedAddress) {
        return "Please upload a valid address verification document.";
    }

    if (params.documentDate && !params.isRecent) {
        return "The submitted address document is older than 3 months. Please upload a more recent proof of address.";
    }

    return null;
}

type CombineAddressSignalsInput = {
    confidence: number;
    extractedText: string;
    matchedName: boolean;
    matchedAddress: boolean;
    matchedResidentialAddress: boolean | null;
    addressDocumentType: AddressDocumentType | null;
    documentDate: Date | null;
    providerSignals?: AddressProviderSignals | null;
};

type AddressNameSignals = {
    matchedName: boolean;
    hasNameConflict: boolean;
    hasKnownNameMismatch: boolean;
};

type AddressDateSignals = {
    resolvedDocumentDate: Date | null;
    recent: boolean;
    hasDocumentDateConflict: boolean;
    hasStrongProviderRescue: boolean;
};

type AddressCountrySignals = {
    isNigeriaConfirmed: boolean;
    isNonNigeriaConfirmed: boolean;
    providerCountry: string | null;
    providerCountryCode: string | null;
};

function isNigeriaCountryName(country?: string | null): boolean {
    const normalized = normalizeString(country || "");
    return normalized === "nigeria" || normalized === "federal republic of nigeria";
}

function isNigeriaCountryCode(countryCode?: string | null): boolean {
    return normalizeString(countryCode || "") === "ng";
}

function isKnownCountryValue(country?: string | null): boolean {
    const normalized = normalizeString(country || "");
    return Boolean(normalized)
        && normalized !== "unknown"
        && normalized !== "n a"
        && normalized !== "na"
        && normalized !== "null"
        && normalized !== "undefined";
}

function hasNigerianAddressCountryHints(extractedText: string): boolean {
    const normalizedText = normalizeString(extractedText);
    const keywords = [
        "federal republic of nigeria",
        " nigeria ",
        " lagos ",
        " abuja ",
        " naira ",
        " ngn ",
        " phcn ",
        " ekedc ",
        " ikedc ",
        " aedc ",
        " bedc ",
        " ibedc ",
        " eedc ",
        " kedco ",
        " kaedco ",
        " yedc ",
        " gtbank ",
        " guaranty trust bank ",
        " access bank ",
        " first bank ",
        " uba ",
        " zenith bank ",
        " fidelity bank ",
        " fcmb ",
        " stanbic ",
        " stanbic ibtc ",
        " standard chartered ",
        " bank of industry ",
        " polaris bank ",
        " keystone bank ",
        " heritage bank ",
        " unity bank ",
        " titan trust bank ",
        " providus bank ",
        " globus bank ",
        " suntrust bank ",
        " coronation merchant bank ",
        " rand merchant bank ",
        " jaiz bank ",
        " taj bank ",
        " lotus bank ",
        " parallex bank ",
        " sterling bank ",
        " wema bank ",
        " union bank ",
        " ecobank ",
    ];
    const paddedText = ` ${normalizedText} `;

    return keywords.some((keyword) => paddedText.includes(keyword));
}

function resolveCombinedAddressCountrySignals(params: {
    extractedText: string;
    providerCountry?: string | null;
    providerCountryCode?: string | null;
}): AddressCountrySignals {
    const providerCountry = params.providerCountry ?? null;
    const providerCountryCode = params.providerCountryCode ?? null;
    const providerHasCountrySignal = isKnownCountryValue(providerCountry) || isKnownCountryValue(providerCountryCode);

    if (providerHasCountrySignal) {
        const isNigeria = isNigeriaCountryCode(providerCountryCode) || isNigeriaCountryName(providerCountry);

        return {
            isNigeriaConfirmed: isNigeria,
            isNonNigeriaConfirmed: !isNigeria,
            providerCountry,
            providerCountryCode,
        };
    }

    return {
        isNigeriaConfirmed: hasNigerianAddressCountryHints(params.extractedText),
        isNonNigeriaConfirmed: false,
        providerCountry,
        providerCountryCode,
    };
}

function resolveCombinedAddressNameSignals(params: {
    ocrMatchedName: boolean;
    confidence: number;
    providerNameMatches: boolean | null;
}): AddressNameSignals {
    if (params.providerNameMatches === true && !params.ocrMatchedName) {
        if (params.confidence < MIN_CONFIDENCE_THRESHOLD) {
            return {
                matchedName: true,
                hasNameConflict: false,
                hasKnownNameMismatch: false,
            };
        }

        return {
            matchedName: false,
            hasNameConflict: true,
            hasKnownNameMismatch: false,
        };
    }

    if (params.providerNameMatches === false) {
        return {
            matchedName: params.ocrMatchedName,
            hasNameConflict: params.ocrMatchedName,
            hasKnownNameMismatch: !params.ocrMatchedName,
        };
    }

    return {
        matchedName: params.ocrMatchedName,
        hasNameConflict: false,
        hasKnownNameMismatch: false,
    };
}

function resolveCombinedAddressDateSignals(params: {
    ocrDocumentDate: Date | null;
    providerDocumentDate: Date | null;
    providerAddressDocumentType: AddressDocumentType | null;
    providerNameMatches: boolean | null;
}): AddressDateSignals {
    const ocrRecent = isDocumentRecent(params.ocrDocumentDate);
    const providerRecent = params.providerDocumentDate
        ? isDocumentRecent(params.providerDocumentDate)
        : null;

    return {
        resolvedDocumentDate: params.ocrDocumentDate ?? params.providerDocumentDate,
        recent: params.ocrDocumentDate
            ? ocrRecent
            : providerRecent ?? false,
        hasDocumentDateConflict:
            params.ocrDocumentDate !== null
            && params.providerDocumentDate !== null
            && ocrRecent !== providerRecent,
        hasStrongProviderRescue:
            params.providerAddressDocumentType !== null
            && params.providerNameMatches === true
            && providerRecent === true,
    };
}

function buildAddressValidationResult(params: {
    input: CombineAddressSignalsInput;
    matchedName: boolean;
    matchedAddress: boolean;
    addressDocumentType: AddressDocumentType | null;
    resolvedDocumentDate: Date | null;
    recent: boolean;
    countryConfirmed: boolean;
    decision: DocumentValidationDecision;
    reason?: string;
    providerDocumentType: string | null;
    providerNameMatches: boolean | null;
    providerDocumentDate: string | null;
    providerCountry: string | null;
    providerCountryCode: string | null;
    providerVerified: boolean | null;
    providerReason: string | null;
}): DocumentValidationResult {
    return {
        isValid: params.decision === "APPROVE",
        confidence: params.input.confidence,
        extractedText: params.input.extractedText,
        matchedName: params.matchedName,
        matchedAddress: params.matchedAddress,
        matchedResidentialAddress: params.input.matchedResidentialAddress,
        addressDocumentType: params.addressDocumentType,
        isAllowedDocumentType: params.matchedAddress,
        requiresManualReview: params.decision === "REVIEW",
        decision: params.decision,
        reason: params.reason,
        documentDate: params.resolvedDocumentDate?.toISOString(),
        isRecent: params.recent,
        countryConfirmed: params.countryConfirmed,
        providerDocumentType: params.providerDocumentType,
        providerNameMatches: params.providerNameMatches,
        providerDocumentDate: params.providerDocumentDate,
        providerCountry: params.providerCountry,
        providerCountryCode: params.providerCountryCode,
        providerVerified: params.providerVerified,
        providerReason: params.providerReason,
    };
}

function buildAddressProviderRejectReason(reason?: string | null): string {
    const normalized = normalizeString(reason || "");

    if (normalized.includes("blur") || normalized.includes("unclear")) {
        return "We could not verify this document. Please upload a clearer original document.";
    }

    return "Please upload a valid address verification document.";
}

function resolveAddressNameMismatchDecision(params: {
    confidence: number;
    matchedName: boolean;
    matchedAddress: boolean;
    resolvedDocumentDate: Date | null;
    recent: boolean;
}): { decision: DocumentValidationDecision; reason?: string } {
    if (params.confidence < MIN_CONFIDENCE_THRESHOLD) {
        return {
            decision: "REVIEW",
            reason: buildAddressReviewReason({
                confidence: params.confidence,
                matchedName: params.matchedName,
                matchedAddress: params.matchedAddress,
                documentDate: params.resolvedDocumentDate,
            }),
        };
    }

    return {
        decision: "REJECT",
        reason: buildAddressRejectReason({
            matchedName: params.matchedName,
            matchedAddress: params.matchedAddress,
            documentDate: params.resolvedDocumentDate,
            isRecent: params.recent,
        }) || undefined,
    };
}

function resolveCombinedAddressDecision(params: {
    confidence: number;
    matchedName: boolean;
    matchedAddress: boolean;
    resolvedDocumentDate: Date | null;
    recent: boolean;
    isNigeriaConfirmed: boolean;
    isNonNigeriaConfirmed: boolean;
    hasNameConflict: boolean;
    hasKnownNameMismatch: boolean;
    hasDocumentDateConflict: boolean;
    hasStrongProviderRescue: boolean;
    hasExplicitUnsupportedProviderType: boolean;
}): { decision: DocumentValidationDecision; reason?: string } {
    if (params.isNonNigeriaConfirmed) {
        return {
            decision: "REJECT",
            reason: "Only Nigerian proof of address documents are accepted. Please upload a valid Nigerian address document.",
        };
    }

    if (!params.matchedAddress) {
        if (params.confidence < MIN_CONFIDENCE_THRESHOLD && !params.hasExplicitUnsupportedProviderType) {
            return {
                decision: "REVIEW",
                reason: buildAddressReviewReason({
                    confidence: params.confidence,
                    matchedName: params.matchedName,
                    matchedAddress: params.matchedAddress,
                    documentDate: params.resolvedDocumentDate,
                }),
            };
        }

        return {
            decision: "REJECT",
            reason: buildAddressRejectReason({
                matchedName: params.matchedName,
                matchedAddress: params.matchedAddress,
                documentDate: params.resolvedDocumentDate,
                isRecent: params.recent,
            }) || undefined,
        };
    }

    if (!params.isNigeriaConfirmed) {
        return {
            decision: "REVIEW",
            reason: buildAddressReviewReason({
                confidence: params.confidence,
                matchedName: params.matchedName,
                matchedAddress: params.matchedAddress,
                documentDate: params.resolvedDocumentDate,
                hasUnconfirmedCountry: true,
            }),
        };
    }

    if (params.hasNameConflict || params.hasDocumentDateConflict) {
        return {
            decision: "REVIEW",
            reason: buildAddressReviewReason({
                confidence: params.confidence,
                matchedName: params.matchedName,
                matchedAddress: params.matchedAddress,
                documentDate: params.resolvedDocumentDate,
                hasNameConflict: params.hasNameConflict,
                hasDocumentDateConflict: params.hasDocumentDateConflict,
            }),
        };
    }

    if (params.hasKnownNameMismatch) {
        return {
            decision: "REJECT",
            reason: buildAddressRejectReason({
                matchedName: false,
                matchedAddress: params.matchedAddress,
                documentDate: params.resolvedDocumentDate,
                isRecent: params.recent,
            }) || undefined,
        };
    }

    if (params.resolvedDocumentDate && !params.recent) {
        return {
            decision: "REJECT",
            reason: buildAddressRejectReason({
                matchedName: params.matchedName,
                matchedAddress: params.matchedAddress,
                documentDate: params.resolvedDocumentDate,
                isRecent: false,
            }) || undefined,
        };
    }

    if (!params.resolvedDocumentDate) {
        return {
            decision: "REVIEW",
            reason: buildAddressReviewReason({
                confidence: params.confidence,
                matchedName: params.matchedName,
                matchedAddress: params.matchedAddress,
                documentDate: params.resolvedDocumentDate,
            }),
        };
    }

    if (!params.matchedName) {
        return resolveAddressNameMismatchDecision(params);
    }

    if (params.confidence < MIN_CONFIDENCE_THRESHOLD && !params.hasStrongProviderRescue) {
        return {
            decision: "REVIEW",
            reason: buildAddressReviewReason({
                confidence: params.confidence,
                matchedName: params.matchedName,
                matchedAddress: params.matchedAddress,
                documentDate: params.resolvedDocumentDate,
            }),
        };
    }

    return { decision: "APPROVE" };
}

export function combineAddressSignals(
    params: CombineAddressSignalsInput,
): DocumentValidationResult {
    const providerDocumentType = params.providerSignals?.documentType ?? null;
    const providerRawText = params.providerSignals?.rawText ?? null;
    const providerNameMatches = params.providerSignals?.nameMatches ?? null;
    const providerDocumentDate = params.providerSignals?.documentDate ?? null;
    const providerCountry = params.providerSignals?.country ?? null;
    const providerCountryCode = params.providerSignals?.countryCode ?? null;
    const providerVerified = typeof params.providerSignals?.isValid === "boolean"
        ? params.providerSignals.isValid
        : null;
    const providerReason = params.providerSignals?.reason ?? null;
    const providerAddressDocumentTypeFromName = normalizeAddressProviderDocumentType(providerDocumentType);
    const providerAddressDocumentTypeFromText = providerRawText ? detectAddressDocumentType(providerRawText) : null;
    const providerAddressDocumentType = providerAddressDocumentTypeFromName ?? providerAddressDocumentTypeFromText;
    const providerDate = parseDocumentDateValue(providerDocumentDate) ?? (providerRawText ? extractDocumentDate(providerRawText) : null);
    const hasExplicitUnsupportedProviderType =
        Boolean(providerDocumentType)
        && providerAddressDocumentTypeFromName === null
        && providerAddressDocumentTypeFromText === null;

    const matchedAddress = params.matchedAddress || providerAddressDocumentType !== null;
    const addressDocumentType = params.addressDocumentType ?? providerAddressDocumentType ?? null;
    const nameSignals = resolveCombinedAddressNameSignals({
        ocrMatchedName: params.matchedName,
        confidence: params.confidence,
        providerNameMatches,
    });
    const dateSignals = resolveCombinedAddressDateSignals({
        ocrDocumentDate: params.documentDate,
        providerDocumentDate: providerDate,
        providerAddressDocumentType,
        providerNameMatches,
    });
    const countrySignals = resolveCombinedAddressCountrySignals({
        extractedText: [params.extractedText, providerRawText].filter(Boolean).join("\n"),
        providerCountry,
        providerCountryCode,
    });
    const decisionResult = providerVerified === false
        ? {
            decision: "REJECT" as DocumentValidationDecision,
            reason: buildAddressProviderRejectReason(providerReason),
        }
        : resolveCombinedAddressDecision({
            confidence: params.confidence,
            matchedName: nameSignals.matchedName,
            matchedAddress,
            resolvedDocumentDate: dateSignals.resolvedDocumentDate,
            recent: dateSignals.recent,
            isNigeriaConfirmed: countrySignals.isNigeriaConfirmed,
            isNonNigeriaConfirmed: countrySignals.isNonNigeriaConfirmed,
            hasNameConflict: nameSignals.hasNameConflict,
            hasKnownNameMismatch: nameSignals.hasKnownNameMismatch,
            hasDocumentDateConflict: dateSignals.hasDocumentDateConflict,
            hasStrongProviderRescue: dateSignals.hasStrongProviderRescue,
            hasExplicitUnsupportedProviderType,
        });

    return buildAddressValidationResult({
        input: params,
        matchedName: nameSignals.matchedName,
        matchedAddress,
        addressDocumentType,
        resolvedDocumentDate: dateSignals.resolvedDocumentDate,
        recent: dateSignals.recent,
        countryConfirmed: countrySignals.isNigeriaConfirmed,
        decision: decisionResult.decision,
        reason: decisionResult.reason,
        providerDocumentType,
        providerNameMatches,
        providerDocumentDate,
        providerCountry,
        providerCountryCode,
        providerVerified,
        providerReason,
    });
}

type CombineIncomeSignalsInput = {
    confidence: number;
    extractedText: string;
    matchedName: boolean;
    incomeDocumentType: IncomeDocumentType | null;
    documentDate: Date | null;
    providerSignals?: IncomeProviderSignals | null;
};

function hasIncomeProviderSignals(providerSignals?: IncomeProviderSignals | null): boolean {
    return Boolean(
        providerSignals?.documentType
        || providerSignals?.rawText
        || providerSignals?.documentDate
        || providerSignals?.country
        || providerSignals?.countryCode
        || providerSignals?.reason
        || typeof providerSignals?.nameMatches === "boolean"
        || typeof providerSignals?.isValid === "boolean",
    );
}

function hasHardIncomeProviderRejectReason(reason?: string | null): boolean {
    const normalized = normalizeString(reason || "");

    if (!normalized) {
        return false;
    }

    return [
        "notvalid",
        "invalid",
        "forg",
        "tamper",
        "alter",
        "photocopy",
        "printed",
        "screenshot",
        "fake",
        "counterfeit",
        "manipulat",
        "synthetic",
    ].some((keyword) => normalized.includes(keyword));
}

function buildIncomeProviderRejectReason(reason?: string | null): string {
    const normalized = normalizeString(reason || "");

    if (normalized.includes("blur") || normalized.includes("unclear")) {
        return "We could not verify this bank statement. Please upload a clearer original bank statement.";
    }

    if (!normalized) {
        return "Please upload a valid Nigerian bank statement.";
    }

    if (
        normalized.includes("notvalid")
        || normalized.includes("invalid")
        || normalized.includes("unsupported")
    ) {
        return "Please upload a valid Nigerian bank statement.";
    }

    return "This bank statement could not be verified as an original document. Please upload an original Nigerian bank statement that shows your full name.";
}

function buildIncomeValidationResult(params: {
    input: CombineIncomeSignalsInput;
    matchedName: boolean;
    incomeDocumentType: IncomeDocumentType | null;
    resolvedDocumentDate: Date | null;
    recent: boolean;
    countryConfirmed: boolean;
    decision: DocumentValidationDecision;
    reason: string;
    providerDocumentType: string | null;
    providerNameMatches: boolean | null;
    providerDocumentDate: string | null;
    providerCountry: string | null;
    providerCountryCode: string | null;
    providerVerified: boolean | null;
    providerReason: string | null;
}): DocumentValidationResult {
    return {
        isValid: params.decision === "APPROVE",
        confidence: params.input.confidence,
        extractedText: params.input.extractedText,
        matchedName: params.matchedName,
        incomeDocumentType: params.incomeDocumentType,
        isAllowedDocumentType: params.incomeDocumentType === "BANK_STATEMENT",
        requiresManualReview: params.decision === "REVIEW",
        decision: params.decision,
        reason: params.reason,
        documentDate: params.resolvedDocumentDate?.toISOString(),
        isRecent: params.recent,
        countryConfirmed: params.countryConfirmed,
        providerDocumentType: params.providerDocumentType,
        providerNameMatches: params.providerNameMatches,
        providerDocumentDate: params.providerDocumentDate,
        providerCountry: params.providerCountry,
        providerCountryCode: params.providerCountryCode,
        providerVerified: params.providerVerified,
        providerReason: params.providerReason,
    };
}

function combineIncomeSignals(
    params: CombineIncomeSignalsInput,
): DocumentValidationResult {
    const providerDocumentType = params.providerSignals?.documentType ?? null;
    const providerRawText = params.providerSignals?.rawText ?? null;
    const providerNameMatches = params.providerSignals?.nameMatches ?? null;
    const providerDocumentDate = params.providerSignals?.documentDate ?? null;
    const providerCountry = params.providerSignals?.country ?? null;
    const providerCountryCode = params.providerSignals?.countryCode ?? null;
    const providerVerified = typeof params.providerSignals?.isValid === "boolean"
        ? params.providerSignals.isValid
        : null;
    const providerReason = params.providerSignals?.reason ?? null;
    const providerIncomeDocumentTypeFromName = normalizeIncomeProviderDocumentType(providerDocumentType);
    const providerIncomeDocumentTypeFromText = providerRawText ? detectIncomeDocumentType(providerRawText) : null;
    const providerIncomeDocumentType = providerIncomeDocumentTypeFromName ?? providerIncomeDocumentTypeFromText;
    const hasExplicitUnsupportedProviderType = Boolean(providerDocumentType)
        && providerIncomeDocumentTypeFromName === null
        && providerIncomeDocumentTypeFromText === null;
    const resolvedIncomeDocumentType = params.incomeDocumentType ?? providerIncomeDocumentType ?? null;
    const resolvedDocumentDate = params.documentDate
        ?? parseDocumentDateValue(providerDocumentDate)
        ?? (providerRawText ? extractDocumentDate(providerRawText) : null);
    const recent = isDocumentRecent(resolvedDocumentDate);
    const countrySignals = resolveCombinedAddressCountrySignals({
        extractedText: [params.extractedText, providerRawText].filter(Boolean).join("\n"),
        providerCountry,
        providerCountryCode,
    });
    const nameSignals = resolveCombinedAddressNameSignals({
        ocrMatchedName: params.matchedName,
        confidence: params.confidence,
        providerNameMatches,
    });
    const hasStrongProviderStatementSignals = providerVerified === true
        && resolvedIncomeDocumentType === "BANK_STATEMENT"
        && nameSignals.matchedName
        && countrySignals.isNigeriaConfirmed;

    let decision: DocumentValidationDecision = "REVIEW";
    let reason = "Your bank statement passed automated checks and will be reviewed by our team.";

    if (providerVerified === false) {
        decision = "REJECT";
        reason = buildIncomeProviderRejectReason(providerReason);
    } else if (resolvedIncomeDocumentType !== "BANK_STATEMENT" || hasExplicitUnsupportedProviderType) {
        decision = "REJECT";
        reason = "Only bank statements are accepted for income verification. Please upload a recent bank statement that shows your full name.";
    } else if (countrySignals.isNonNigeriaConfirmed || !countrySignals.isNigeriaConfirmed) {
        decision = "REJECT";
        reason = "Please upload a valid Nigerian bank statement.";
    } else if (!nameSignals.matchedName) {
        decision = "REJECT";
        reason = "The submitted bank statement does not match the name on your profile. Please upload your own recent bank statement.";
    } else if (!resolvedDocumentDate && hasStrongProviderStatementSignals) {
        reason = "We could not confidently confirm the statement date. Your bank statement will be reviewed by our team.";
    } else if (!recent) {
        decision = "REJECT";
        reason = resolvedDocumentDate
            ? "The submitted bank statement is older than 3 months. Please upload a recent bank statement."
            : "We could not confirm a statement date within the last 3 months. Please upload a recent bank statement.";
    }

    return buildIncomeValidationResult({
        input: params,
        matchedName: nameSignals.matchedName,
        incomeDocumentType: resolvedIncomeDocumentType,
        resolvedDocumentDate,
        recent,
        countryConfirmed: countrySignals.isNigeriaConfirmed,
        decision,
        reason,
        providerDocumentType,
        providerNameMatches,
        providerDocumentDate,
        providerCountry,
        providerCountryCode,
        providerVerified,
        providerReason,
    });
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
    providerSignals?: AddressProviderSignals | null,
): Promise<DocumentValidationResult> {
    const ocrResult = await extractTextFromDocument(imageBuffer, mimeType);
    const hasProviderSignals = Boolean(
        providerSignals?.documentType
        || providerSignals?.rawText
        || providerSignals?.documentDate
        || providerSignals?.country
        || providerSignals?.countryCode
        || providerSignals?.reason
        || typeof providerSignals?.nameMatches === "boolean"
        || typeof providerSignals?.isValid === "boolean",
    );

    if ((!ocrResult.text || ocrResult.confidence < 10) && !hasProviderSignals) {
        return {
            isValid: false,
            confidence: ocrResult.confidence,
            extractedText: ocrResult.text,
            matchedName: false,
            matchedAddress: false,
            matchedResidentialAddress: null,
            requiresManualReview: true,
            decision: "REVIEW",
            reason: "Could not extract text from document. Please upload a clearer image.",
        };
    }

    const matchedName = ocrResult.text
        ? checkNameInText(ocrResult.text, firstName, lastName)
        : false;
    const addressDocumentType = ocrResult.text
        ? detectAddressDocumentType(ocrResult.text)
        : null;
    const matchedAddress = addressDocumentType !== null;
    const matchedResidentialAddress = ocrResult.text
        ? checkResidentialAddressMatch(ocrResult.text, residentialAddress)
        : null;
    const docDate = ocrResult.text ? extractDocumentDate(ocrResult.text) : null;

    return combineAddressSignals({
        confidence: ocrResult.confidence,
        extractedText: ocrResult.text,
        matchedName,
        matchedAddress,
        matchedResidentialAddress,
        addressDocumentType,
        documentDate: docDate,
        providerSignals,
    });
}

/**
 * Validate an income document.
 * Only recent Nigerian bank statements that match the profile name are accepted,
 * and accepted documents still move to manual review.
 */
export async function validateIncomeDocument(
    imageBuffer: Buffer,
    firstName: string,
    lastName: string,
    mimeType?: string,
    providerSignals?: IncomeProviderSignals | null,
): Promise<DocumentValidationResult> {
    const ocrResult = await extractTextFromDocument(imageBuffer, mimeType);
    const extractedText = ocrResult.text || "";
    const incomeDocumentType = extractedText ? detectIncomeDocumentType(extractedText) : null;
    const matchedName = extractedText ? checkNameInText(extractedText, firstName, lastName) : false;
    const docDate = extractedText ? extractDocumentDate(extractedText) : null;
    const hasProviderData = hasIncomeProviderSignals(providerSignals);

    if ((!extractedText || ocrResult.confidence < 10) && !hasProviderData) {
        return {
            isValid: false,
            confidence: ocrResult.confidence,
            extractedText,
            matchedName: false,
            incomeDocumentType,
            isAllowedDocumentType: false,
            requiresManualReview: false,
            decision: "REJECT",
            reason: "We could not read enough details from the uploaded bank statement. Please upload a clearer bank statement.",
            documentDate: docDate?.toISOString(),
            isRecent: isDocumentRecent(docDate),
            countryConfirmed: extractedText ? hasNigerianAddressCountryHints(extractedText) : false,
        };
    }

    return combineIncomeSignals({
        confidence: ocrResult.confidence,
        extractedText,
        matchedName,
        incomeDocumentType,
        documentDate: docDate,
        providerSignals,
    });
}
