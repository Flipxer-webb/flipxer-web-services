const randomIntMock = jest.fn();
const hashMock = jest.fn();
const compareMock = jest.fn();

jest.mock("node:crypto", () => ({
    randomInt: (...args: unknown[]) => randomIntMock(...args),
    __esModule: true,
}));

jest.mock("bcryptjs", () => ({
    hash: (...args: unknown[]) => hashMock(...args),
    compare: (...args: unknown[]) => compareMock(...args),
    __esModule: true,
}));

import {
    generateBackupCodes,
    hashBackupCodes,
    removeUsedBackupCode,
    verifyBackupCode,
} from "../backup-codes.util";
import {
    convertToNGN,
    getTierThreshold,
    isTwoFactorRequiredForTransaction,
    TIER_THRESHOLDS,
} from "../tier-threshold.util";

describe("auth utils", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("generates unique formatted backup codes even when random output repeats", () => {
        const seq = [
            ...Array(20).fill(0), // first two generated codes are duplicates (AAAAAAAAAA)
            ...Array(10).fill(1), // third generated code is different (BBBBBBBBBB)
        ];
        randomIntMock.mockImplementation(() => {
            if (!seq.length) return 2;
            return seq.shift();
        });

        const codes = generateBackupCodes(2);

        expect(codes).toEqual(["AAAA-AAAA-AA", "BBBB-BBBB-BB"]);
        expect(codes).toHaveLength(2);
        expect(codes.every((c) => /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{2}$/.test(c))).toBe(true);
    });

    it("uses default count when count is omitted", () => {
        let call = -1;
        randomIntMock.mockImplementation(() => {
            call += 1;
            return call % 36;
        });

        const codes = generateBackupCodes();

        expect(codes).toHaveLength(10);
        expect(new Set(codes).size).toBe(10);
    });

    it("hashes backup codes", async () => {
        hashMock
            .mockResolvedValueOnce("h1")
            .mockResolvedValueOnce("h2");

        await expect(hashBackupCodes(["C1", "C2"])).resolves.toEqual(["h1", "h2"]);
        expect(hashMock).toHaveBeenNthCalledWith(1, "C1", 10);
        expect(hashMock).toHaveBeenNthCalledWith(2, "C2", 10);
    });

    it("verifies backup code and returns matching index", async () => {
        compareMock
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);

        await expect(verifyBackupCode("plain", ["h1", "h2", "h3"])).resolves.toBe(1);
        expect(compareMock).toHaveBeenCalledTimes(2);
    });

    it("returns -1 when backup code does not match any hash", async () => {
        compareMock
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(false);

        await expect(verifyBackupCode("plain", ["h1", "h2"])).resolves.toBe(-1);
        expect(compareMock).toHaveBeenCalledTimes(2);
    });

    it("removes used backup code by index", () => {
        expect(removeUsedBackupCode(["a", "b", "c"], 1)).toEqual(["a", "c"]);
    });

    it("returns false when 2FA is disabled", () => {
        expect(isTwoFactorRequiredForTransaction(1, 1_000_000, false)).toBe(false);
    });

    it("applies tier thresholds and invalid-tier fallback", () => {
        expect(isTwoFactorRequiredForTransaction(1, 49_999, true)).toBe(false);
        expect(isTwoFactorRequiredForTransaction(1, 50_000, true)).toBe(true);
        expect(isTwoFactorRequiredForTransaction(2, 100_000, true)).toBe(true);
        expect(isTwoFactorRequiredForTransaction(3, 499_999, true)).toBe(false);

        // Invalid tier falls back to tier 0, which always requires 2FA when enabled.
        expect(isTwoFactorRequiredForTransaction(99, 1, true)).toBe(true);
    });

    it("returns threshold config and converts amounts to NGN", () => {
        expect(getTierThreshold(2)).toEqual(TIER_THRESHOLDS[2]);
        expect(getTierThreshold(999)).toEqual(TIER_THRESHOLDS[0]);
        expect(convertToNGN(2.5, 1500)).toBe(3750);
    });
});
