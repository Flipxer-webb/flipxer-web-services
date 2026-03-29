jest.mock("@/config", () => ({
    encryptSecret: "unit-test-secret",
}));

const redisOnceMock = jest.fn();

jest.mock("ioredis", () =>
    jest.fn().mockImplementation(() => ({
        once: redisOnceMock,
    }))
);

const shapeTransactionMock = jest.fn((tx: any, filter?: boolean) => ({
    id: tx.id,
    shaped: true,
    filter,
}));

jest.mock("@/modules/api/transactions/types", () => ({
    shapeTransaction: (tx: unknown, filter?: boolean) =>
        shapeTransactionMock(tx, filter),
}));

import Redis from "ioredis";
import {
    decryptField,
    encrypt,
    encryptField,
    formatLocalPhoneToIntlWithoutPlus,
    formatName,
    formatTimestamp,
    generateFileName,
    generateId,
    generateRandomNum,
    generateSlug,
    groupBy,
    groupTransactionsByDate,
    waitForRedis,
} from "../index";

describe("utils/index", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("generates IDs for supported types", () => {
        expect(generateId({ type: "reference" })?.length).toBe(30);
        expect(generateId({ type: "transaction" })?.length).toBe(15);
        expect(generateId({ type: "identifier" })?.length).toBe(16);
        expect(generateId({ type: "custom_lower_case", length: 6 })).toMatch(
            /^[0-9a-h]{6}$/
        );
        expect(generateId({ type: "custom_upper_case", length: 6 })).toMatch(
            /^[0-9A-H]{6}$/
        );
        expect(generateId({ type: "sessionId" })).toMatch(/^\d{15}$/);

        const numeric = generateId({ type: "numeric", length: 8 });
        expect(numeric).toMatch(/^\d{8}$/);

        expect(
            generateId({ type: "unknown_type" as any, length: 10 } as any)
        ).toBeUndefined();
    });

    it("formats names", () => {
        expect(formatName("  jOhN  ")).toBe("John");
    });

    it("encrypts values using AES wrapper", () => {
        const encrypted = encrypt({ a: 1, b: "ok" });
        expect(typeof encrypted).toBe("string");
        expect(encrypted.length).toBeGreaterThan(10);
    });

    it("encrypts and decrypts fields with GCM", () => {
        const ciphertext = encryptField("sensitive-value");
        expect(ciphertext.split(":")).toHaveLength(3);
        expect(decryptField(ciphertext)).toBe("sensitive-value");
    });

    it("returns original value for non-GCM field strings", () => {
        expect(decryptField("plaintext")).toBe("plaintext");
        expect(decryptField("bad:format")).toBe("bad:format");
    });

    it("generates slugs", () => {
        expect(generateSlug("Hello World!")).toBe("hello-world");
    });

    it("groups array items by key", () => {
        const rows = [
            { id: 1, type: "a" },
            { id: 2, type: "a" },
            { id: 3, type: "b" },
        ];

        const grouped = groupBy("type", rows);
        expect(grouped).toHaveLength(2);
        expect(grouped[0].length + grouped[1].length).toBe(3);
    });

    it("generates numeric strings", () => {
        const out = generateRandomNum(12);
        expect(out).toMatch(/^\d{12}$/);
    });

    it("creates a Redis client with retry/reconnect options", () => {
        waitForRedis({
            host: "localhost",
            port: 6379,
            user: "user",
            password: process.env.REDIS_TEST_PASSWORD || "",
            redisOptions: {
                tls: {},
            },
        } as any);

        const RedisMock = Redis as unknown as jest.Mock;
        expect(RedisMock).toHaveBeenCalledTimes(1);
        expect(redisOnceMock).toHaveBeenCalledWith("connect", expect.any(Function));

        const options = RedisMock.mock.calls[0][0];
        expect(options.retryStrategy(2)).toBe(400);
        expect(options.retryStrategy(11)).toBeNull();
        expect(options.reconnectOnError(new Error("READONLY replica"))).toBe(true);
        expect(options.reconnectOnError(new Error("Too many requests"))).toBe(true);
        expect(options.reconnectOnError(new Error("ECONNRESET"))).toBe(false);
    });

    it("formats local phone to international form without plus", () => {
        expect(formatLocalPhoneToIntlWithoutPlus("08012345678")).toBe("2348012345678");
    });

    it("groups transactions by date labels and shapes entries", () => {
        const now = new Date();
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const older = new Date("2024-01-03T00:00:00.000Z");

        const grouped = groupTransactionsByDate(
            [
                { id: 1, createdAt: now },
                { id: 2, createdAt: yesterday },
                { id: 3, createdAt: older },
            ] as any,
            true
        );

        expect(grouped.length).toBeGreaterThanOrEqual(2);
        expect(shapeTransactionMock).toHaveBeenCalled();
        expect(grouped.flatMap((g) => g.transactions).every((t: any) => t.shaped)).toBe(true);
    });

    it("uses default filter=false when grouping transactions", () => {
        shapeTransactionMock.mockClear();

        groupTransactionsByDate([{ id: 99, createdAt: new Date() }] as any);

        expect(shapeTransactionMock).toHaveBeenCalledWith(
            expect.objectContaining({ id: 99 }),
            false
        );
    });

    it("formats compact timestamps and file names", () => {
        expect(formatTimestamp()).toMatch(/^\d{14}$/);
        const fileName = generateFileName("Proof Of Address", 99, "id.png");
        expect(fileName).toMatch(/^proof_of_address_99_\d{14}\.png$/);

        const fallbackExt = generateFileName("passport", 7);
        expect(fallbackExt.endsWith(".pdf")).toBe(true);
    });
});