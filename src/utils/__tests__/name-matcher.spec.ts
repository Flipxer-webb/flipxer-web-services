import {
    jaroWinklerSimilarity,
    normaliseName,
    matchNames,
    matchDateOfBirth,
} from "../name-matcher";

describe("normaliseName", () => {
    it("lowercases and trims", () => {
        expect(normaliseName("  JOHN  ")).toBe("john");
    });

    it("strips diacritical marks", () => {
        expect(normaliseName("Déborah")).toBe("deborah");
        expect(normaliseName("Olùwáṣeun")).toBe("oluwaseun");
    });

    it("converts hyphens to spaces and collapses whitespace", () => {
        expect(normaliseName("Nwabekeyi-Obi    Peter")).toBe("nwabekeyi obi peter");
    });
});

describe("jaroWinklerSimilarity", () => {
    it("returns 1 for identical strings", () => {
        expect(jaroWinklerSimilarity("john", "john")).toBe(1);
    });

    it("returns 0 for empty input", () => {
        expect(jaroWinklerSimilarity("", "john")).toBe(0);
        expect(jaroWinklerSimilarity("john", "")).toBe(0);
    });

    it("returns high score for minor typo", () => {
        const score = jaroWinklerSimilarity("olaoluwa", "olaoluwaa");
        expect(score).toBeGreaterThan(0.9);
    });

    it("returns low score for unrelated strings", () => {
        const score = jaroWinklerSimilarity("john", "xyz");
        expect(score).toBeLessThan(0.5);
    });
});

describe("matchNames", () => {
    it("matches exact names", () => {
        const result = matchNames("John", "Doe", "John", "Doe");
        expect(result.matches).toBe(true);
        expect(result.score).toBe(1);
    });

    it("matches swapped first/last names", () => {
        const result = matchNames("John", "Doe", "Doe", "John");
        expect(result.matches).toBe(true);
        expect(result.score).toBe(1);
    });

    it("matches with minor typos", () => {
        const result = matchNames("Olaoluwa", "Ibukun", "Olaoluwaa", "Ibukun");
        expect(result.matches).toBe(true);
        expect(result.score).toBeGreaterThan(0.85);
    });

    it("matches with diacritics difference", () => {
        const result = matchNames("Oluwaseun", "Adéyẹmí", "Oluwaseun", "Adeyemi");
        expect(result.matches).toBe(true);
    });

    it("rejects completely different names", () => {
        const result = matchNames("John", "Doe", "Alice", "Smith");
        expect(result.matches).toBe(false);
        expect(result.score).toBeLessThan(0.85);
    });

    it("respects custom threshold", () => {
        const result = matchNames("Jon", "Doe", "John", "Doe", 0.99);
        expect(result.matches).toBe(false);
    });

    it("includes detail string with scores", () => {
        const result = matchNames("John", "Doe", "John", "Doe");
        expect(result.detail).toContain("score=");
    });
});

describe("matchDateOfBirth", () => {
    it("matches identical ISO dates", () => {
        expect(matchDateOfBirth("1990-05-15", "1990-05-15")).toBe(true);
    });

    it("matches DD-MM-YYYY against ISO", () => {
        expect(matchDateOfBirth("15-05-1990", "1990-05-15")).toBe(true);
    });

    it("matches DD/MM/YYYY against ISO", () => {
        expect(matchDateOfBirth("15/05/1990", "1990-05-15")).toBe(true);
    });

    it("returns false for different dates", () => {
        expect(matchDateOfBirth("1990-05-15", "1990-06-15")).toBe(false);
    });

    it("returns false for empty strings", () => {
        expect(matchDateOfBirth("", "1990-05-15")).toBe(false);
        expect(matchDateOfBirth("1990-05-15", "")).toBe(false);
    });

    it("returns false for invalid format", () => {
        expect(matchDateOfBirth("May 15, 1990", "1990-05-15")).toBe(false);
    });
});
