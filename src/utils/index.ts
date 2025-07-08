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
    let str = "";
    for (let i = 0; i < size; i++) {
        const rand = Math.floor(Math.random() * 10);
        str += rand;
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
    };

    const client = new Redis(redisOptions);
    new Promise((resolve) => client.once("connect", resolve));
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

export const groupTransactionsByDate = (transactions: Order[]) => {
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
                shapeTransaction(t as TransactionIncludeOptions)
            ),
        })
    );

    return groupedArray;
};

export const formatTimestamp = () =>
    new Date()
        .toISOString()
        .replace(/[-:.TZ]/g, "")
        .slice(0, 14);

export const generateFileName = (
    docType: string,
    userId: number,
    originalName?: string
) => {
    const ext = originalName?.split(".").pop()?.toLowerCase() || "pdf";
    const sanitizedType = docType.toLowerCase().replace(/\s+/g, "_");
    return `${sanitizedType}_${userId}_${formatTimestamp()}.${ext}`;
};
