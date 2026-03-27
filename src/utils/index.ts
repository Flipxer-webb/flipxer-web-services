import { customAlphabet, urlAlphabet } from "nanoid";
import { TransactionIdOption } from "./interfaces";
import { AES } from "crypto-js";
import { encryptSecret, RedisConfig } from "@/config";
import slugify from "slugify";
import Redis, { RedisOptions } from "ioredis";
import { Order } from "@prisma/client";
import { isToday, isYesterday, format } from "date-fns";
import {
    shapeTransaction,
    TransactionIncludeOptions,
} from "@/modules/api/transactions/types";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

export * from "./api-response-util";
export * from "./interfaces";

export const generateId = (options: TransactionIdOption): string => {
    const alphaNumeric = "1234567890ABCDEFGH";
    const numeric = "0123456789";
    const length = options.length ?? 15;

    switch (options.type) {
        case "reference": {
            return customAlphabet(alphaNumeric.toLowerCase(), 30)();
        }
        case "transaction": {
            return customAlphabet(alphaNumeric, 15)();
        }
        case "custom_lower_case": {
            return customAlphabet(alphaNumeric.toLowerCase(), length)();
        }
        case "custom_upper_case": {
            return customAlphabet(alphaNumeric, length)();
        }

        case "numeric": {
            return customAlphabet(numeric, length)();
        }
        case "identifier": {
            return customAlphabet(urlAlphabet, 16)();
        }
        case "sessionId": {
            return customAlphabet(numeric, 15)();
        }

        default:
            break;
    }
};

export const formatName = (name: string) => {
    const formatted = name.trim().toLowerCase();
    return `${formatted.charAt(0).toUpperCase()}${formatted.slice(1)}`;
};

export const encrypt = (data: any) => {
    return AES.encrypt(JSON.stringify(data), encryptSecret).toString();
};

const _fieldEncryptionKey = scryptSync(encryptSecret, "flipxer-field-salt", 32);

export const encryptField = (plaintext: string): string => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", _fieldEncryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
};

export const decryptField = (ciphertext: string): string => {
    if (!ciphertext.includes(":")) return ciphertext;
    const parts = ciphertext.split(":");
    if (parts.length !== 3) return ciphertext;
    const [ivHex, tagHex, encryptedHex] = parts;
    const decipher = createDecipheriv("aes-256-gcm", _fieldEncryptionKey, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return decipher.update(Buffer.from(encryptedHex, "hex"), undefined, "utf8") + decipher.final("utf8");
};

export const generateSlug = (input: string) => {
    const options = {
        strict: true,
        lower: true,
    };
    return slugify(input, options);
};

export function groupBy<TData extends Record<string, any>>(
    key: string,
    data: TData[]
): TData[][] {
    const list = data.reduce((hash, obj) => {
        hash[obj[key]] = (hash[obj[key]] || []).concat(obj);
        return hash;
    }, {});

    return Object.values(list);
}

export const generateRandomNum = (size: number): string => {
    const { randomInt } = require("node:crypto");
    let str = "";
    for (let i = 0; i < size; i++) {
        str += randomInt(0, 10).toString();
    }
    return str;
};

export const waitForRedis = (config: RedisConfig) => {
    const redisOptions: RedisOptions = {
        lazyConnect: false,
        showFriendlyErrorStack: true,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        tls: config.redisOptions.tls,
        host: config.host,
        username: config.user,
        password: config.password,
        port: config.port,
        // Retry strategy with exponential backoff
        retryStrategy: (times: number) => {
            // Max 10 retries
            if (times > 10) {
                console.error(`Redis: Max retries (${times}) exceeded, giving up`);
                return null;
            }
            // Exponential backoff: 100ms, 200ms, 400ms, 800ms, 1600ms... up to 30s
            const delay = Math.min(Math.pow(2, times) * 100, 30000);
            console.log(`Redis: Retry attempt ${times}, waiting ${delay}ms`);
            return delay;
        },
        // Reconnect on error (including rate limiting)
        reconnectOnError: (err: Error) => {
            const targetErrors = ["READONLY", "Too many requests"];
            if (targetErrors.some(e => err.message.includes(e))) {
                console.log(`Redis: Reconnecting due to error: ${err.message}`);
                return true;
            }
            return false;
        },
    };

    const client = new Redis(redisOptions);
    client.once("connect", () => {});
};

export function formatLocalPhoneToIntlWithoutPlus(phone: string) {
    return `234${phone.substring(1)}`;
}

export const defaultPagination = {
    pageNumber: 1,
    pageSize: 10,
    startDate: new Date("1970-01-01"),
    endDate: new Date(),
    search: "",
};

export const groupTransactionsByDate = (
    transactions: Order[],
    filter = false
) => {
    const groupedMap: Record<string, Order[]> = {};

    for (const tx of transactions) {
        let label: string;

        if (isToday(tx.createdAt)) {
            label = "Today";
        } else if (isYesterday(tx.createdAt)) {
            label = "Yesterday";
        } else {
            label = format(tx.createdAt, "dd-MM-yyyy");
        }

        if (!groupedMap[label]) {
            groupedMap[label] = [];
        }

        groupedMap[label].push(tx);
    }

    // Convert to an array format
    const groupedArray = Object.entries(groupedMap).map(
        ([date, transactions]) => ({
            date,
            transactions: transactions.map((t) =>
                shapeTransaction(t as TransactionIncludeOptions, filter)
            ),
        })
    );

    return groupedArray;
};

export const formatTimestamp = () =>
    new Date()
        .toISOString()
        .replaceAll(/[-:.TZ]/g, "")
        .slice(0, 14);

export const generateFileName = (
    docType: string,
    userId: number,
    originalName?: string
) => {
    const ext = originalName?.split(".").pop()?.toLowerCase() || "pdf";
    const sanitizedType = docType.toLowerCase().replaceAll(/\s+/g, "_");
    return `${sanitizedType}_${userId}_${formatTimestamp()}.${ext}`;
};
