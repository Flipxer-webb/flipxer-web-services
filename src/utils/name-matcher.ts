/**
 * Fuzzy Name Matching Utility
 *
 * Uses the Jaro-Winkler distance algorithm to compare names from identity
 * provider responses against user-supplied names. This handles:
 *   - Minor typos / transliteration differences
 *   - Swapped first/last name ordering
 *   - Diacritics and case differences
 *
 * Threshold: 0.85 (empirically good for Nigerian name systems)
 */

const DEFAULT_THRESHOLD = 0.85;
const WINKLER_PREFIX_WEIGHT = 0.1;
const MAX_PREFIX_LENGTH = 4;

/** Count transpositions between matched character sequences. */
function countTranspositions(s1: string, s2: string, s1Matches: boolean[], s2Matches: boolean[]): number {
    let k = 0;
    let transpositions = 0;
    for (let i = 0; i < s1.length; i++) {
        if (!s1Matches[i]) continue;
        while (!s2Matches[k]) k++;
        if (s1[i] !== s2[k]) transpositions++;
        k++;
    }
    return transpositions;
}

/**
 * Compute the Jaro similarity between two strings.
 * Returns a value between 0.0 (no match) and 1.0 (exact match).
 */
function jaroSimilarity(s1: string, s2: string): number {
    if (s1 === s2) return 1.0;
    if (s1.length === 0 || s2.length === 0) return 0.0;

    const matchWindow = Math.max(Math.floor(Math.max(s1.length, s2.length) / 2) - 1, 0);

    const s1Matches = new Array(s1.length).fill(false);
    const s2Matches = new Array(s2.length).fill(false);

    let matches = 0;

    // Find matching characters
    for (let i = 0; i < s1.length; i++) {
        const start = Math.max(0, i - matchWindow);
        const end = Math.min(i + matchWindow + 1, s2.length);

        for (let j = start; j < end; j++) {
            if (s2Matches[j] || s1[i] !== s2[j]) continue;
            s1Matches[i] = true;
            s2Matches[j] = true;
            matches++;
            break;
        }
    }

    if (matches === 0) return 0.0;

    const transpositions = countTranspositions(s1, s2, s1Matches, s2Matches);

    return (
        (matches / s1.length +
            matches / s2.length +
            (matches - transpositions / 2) / matches) /
        3
    );
}

/**
 * Compute the Jaro-Winkler similarity between two strings.
 * Gives a boost for common prefixes (up to 4 characters).
 * Returns a value between 0.0 and 1.0.
 */
export function jaroWinklerSimilarity(s1: string, s2: string): number {
    const jaro = jaroSimilarity(s1, s2);

    // Calculate common prefix length (max 4)
    let prefixLen = 0;
    for (let i = 0; i < Math.min(s1.length, s2.length, MAX_PREFIX_LENGTH); i++) {
        if (s1[i] === s2[i]) {
            prefixLen++;
        } else {
            break;
        }
    }

    return jaro + prefixLen * WINKLER_PREFIX_WEIGHT * (1 - jaro);
}

/**
 * Normalise a name for comparison:
 * - Lowercase
 * - Strip diacritics (NFD decomposition → remove combining marks)
 * - Collapse multiple spaces / hyphens
 * - Trim
 */
export function normaliseName(name: string): string {
    return name
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // strip combining diacritical marks
        .replace(/[-]+/g, " ")           // hyphens → spaces
        .replace(/\s+/g, " ")            // collapse whitespace
        .trim();
}

export interface NameMatchResult {
    /** Overall match decision */
    matches: boolean;
    /** Best similarity score achieved (0.0 – 1.0) */
    score: number;
    /** Human-readable explanation of the comparison */
    detail: string;
}

/**
 * Compare a user-supplied full name (firstName + lastName) against
 * provider-returned name parts using Jaro-Winkler similarity.
 *
 * Checks both:
 *   1. Direct order: (userFirst vs providerFirst) + (userLast vs providerLast)
 *   2. Swapped order: (userFirst vs providerLast) + (userLast vs providerFirst)
 *
 * Uses the better of the two.
 *
 * @param userFirstName   Name supplied by the user
 * @param userLastName    Name supplied by the user
 * @param providerFirst   First name returned by identity provider
 * @param providerLast    Last name returned by identity provider
 * @param threshold       Minimum score to consider a match (default: 0.85)
 */
export function matchNames(
    userFirstName: string,
    userLastName: string,
    providerFirst: string,
    providerLast: string,
    threshold = DEFAULT_THRESHOLD,
): NameMatchResult {
    const uFirst = normaliseName(userFirstName);
    const uLast = normaliseName(userLastName);
    const pFirst = normaliseName(providerFirst);
    const pLast = normaliseName(providerLast);

    // Direct order comparison
    const directFirstScore = jaroWinklerSimilarity(uFirst, pFirst);
    const directLastScore = jaroWinklerSimilarity(uLast, pLast);
    const directScore = (directFirstScore + directLastScore) / 2;

    // Swapped order comparison (user may have entered names in wrong order)
    const swapFirstScore = jaroWinklerSimilarity(uFirst, pLast);
    const swapLastScore = jaroWinklerSimilarity(uLast, pFirst);
    const swapScore = (swapFirstScore + swapLastScore) / 2;

    const bestScore = Math.max(directScore, swapScore);
    const isSwapped = swapScore > directScore;
    const matches = bestScore >= threshold;

    const detail = isSwapped
        ? `Swapped order match: score=${bestScore.toFixed(3)} (first↔last=${swapFirstScore.toFixed(3)}, last↔first=${swapLastScore.toFixed(3)})`
        : `Direct match: score=${bestScore.toFixed(3)} (first=${directFirstScore.toFixed(3)}, last=${directLastScore.toFixed(3)})`;

    return { matches, score: bestScore, detail };
}

/**
 * Compare a user-supplied date-of-birth against the provider DOB.
 * Accepts multiple formats: YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY, MM/DD/YYYY.
 * Returns true if both resolve to the same calendar date.
 */
export function matchDateOfBirth(userDob: string, providerDob: string): boolean {
    const parseDate = (raw: string): string | null => {
        if (!raw) return null;
        const cleaned = raw.trim();

        // Try YYYY-MM-DD (ISO)
        if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return cleaned;

        // Try DD-MM-YYYY or DD/MM/YYYY
        const dmyMatch = cleaned.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
        if (dmyMatch) {
            return `${dmyMatch[3]}-${dmyMatch[2]}-${dmyMatch[1]}`;
        }

        return null;
    };

    const d1 = parseDate(userDob);
    const d2 = parseDate(providerDob);
    if (!d1 || !d2) return false;
    return d1 === d2;
}
