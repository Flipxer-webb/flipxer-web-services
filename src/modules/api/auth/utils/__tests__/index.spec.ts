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
    AUTHENTICATOR_OR_BACKUP_CODE_REGEX,
    BACKUP_CODE_GROUP_COUNT,
    BACKUP_CODE_GROUP_LENGTH,
    BACKUP_CODE_INPUT_MAX_LENGTH,
    BACKUP_CODE_INPUT_PATTERN,
    BACKUP_CODE_RAW_LENGTH,
    DEFAULT_BACKUP_CODES_COUNT,
} from "../backup-codes.constants";
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
            ...new Array(40).fill(0), // first two generated codes are duplicates (AAAA...)
            ...new Array(20).fill(1), // third generated code is different (BBBB...)
        ];
        randomIntMock.mockImplementation(() => {
            if (!seq.length) return 2;
            return seq.shift();
        });

        const codes = generateBackupCodes(2);

        expect(codes).toEqual(["AAAAA-AAAAA-AAAAA-AAAAA", "BBBBB-BBBBB-BBBBB-BBBBB"]);
        expect(codes).toHaveLength(2);
        expect(codes.every((c) => /^[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(c))).toBe(true);
    });

    it("uses default count when count is omitted", () => {
        let call = -1;
        randomIntMock.mockImplementation(() => {
            call += 1;
            return call % 36;
        });

        const codes = generateBackupCodes();

        expect(codes).toHaveLength(5);
        expect(new Set(codes).size).toBe(5);
    });

    it("exposes backup code constants and regex patterns", () => {
        expect(BACKUP_CODE_GROUP_LENGTH).toBe(5);
        expect(BACKUP_CODE_GROUP_COUNT).toBe(4);
        expect(BACKUP_CODE_RAW_LENGTH).toBe(20);
        expect(BACKUP_CODE_INPUT_MAX_LENGTH).toBe(23);
        expect(DEFAULT_BACKUP_CODES_COUNT).toBe(5);

        const backupCodeRegex = new RegExp(`^${BACKUP_CODE_INPUT_PATTERN}$`);

        expect(backupCodeRegex.test("ABCDE-FGHIJ-KLMNO-PQRST")).toBe(true);
        expect(backupCodeRegex.test("ABCDEFGHIJKLMNOPQRST")).toBe(true);
        expect(AUTHENTICATOR_OR_BACKUP_CODE_REGEX.test("123456")).toBe(true);
        expect(
            AUTHENTICATOR_OR_BACKUP_CODE_REGEX.test("ABCDE FGHIJ KLMNO PQRST")
        ).toBe(true);
        expect(AUTHENTICATOR_OR_BACKUP_CODE_REGEX.test("12345")).toBe(false);
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
