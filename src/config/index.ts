import { config } from "dotenv";
import validate, {
    RequiredEnvironment,
    RequiredEnvironmentTypes,
} from "@boxpositron/vre";
import { ConfigOptions } from "cloudinary";
import { PaystackOptions } from "@/libs/paystack";
import { TermiiOptions } from "@/libs/termii";

export * from "./constants";

config();

const runtimeEnvironment: RequiredEnvironment[] = [
    // Existing entries...
    {
        name: "PORT",
        type: RequiredEnvironmentTypes.Number,
    },
    {
        name: "DATABASE_URL",
        type: RequiredEnvironmentTypes.String,
    },
    {
        name: "ALLOWED_DOMAINS",
        type: RequiredEnvironmentTypes.String,
    },
    // Mail
    {
        name: "ZEPTOMAIL_URL",
        type: RequiredEnvironmentTypes.String,
    },
    {
        name: "ZEPTOMAIL_TOKEN",
        type: RequiredEnvironmentTypes.String,
    },
    {
        name: "ZEPTOMAIL_SENDER",
        type: RequiredEnvironmentTypes.String,
    },
    // Templates
    {
        name: "REGISTRATION_SUCCESS_TEMPLATE",
        type: RequiredEnvironmentTypes.String,
    },
    {
        name: "VERIFY_ACCOUNT_TEMPLATE",
        type: RequiredEnvironmentTypes.String,
    },
    {
        name: "FORGOT_PASSWORD_TEMPLATE",
        type: RequiredEnvironmentTypes.String,
    },
    {
        name: "RECOVERY_PIN_TEMPLATE",
        type: RequiredEnvironmentTypes.String,
    },
    {
        name: "TRANSACTION_NOTIFICATION_TEMPLATE",
        type: RequiredEnvironmentTypes.String,
    },
    {
        name: "FAILED_TRANSACTION_TEMPLATE",
        type: RequiredEnvironmentTypes.String,
    },
    {
        name: "JWT_SECRET",
        type: RequiredEnvironmentTypes.String,
    },
    {
        name: "FRONTEND_DEV_DOMAIN",
        type: RequiredEnvironmentTypes.String,
    },
    {
        name: "JWT_REFRESH_SECRET",
        type: RequiredEnvironmentTypes.String,
    },

    //
    {
        name: "ENCRYPT_SECRET",
        type: RequiredEnvironmentTypes.String,
    },

    //cloud bucket
    {
        name: "PROFILE_DIR",
        type: RequiredEnvironmentTypes.String,
    },
    {
        name: "DOCUMENT_DIR",
        type: RequiredEnvironmentTypes.String,
    },

    //server environment
    {
        name: "ENVIRONMENT",
        type: RequiredEnvironmentTypes.String,
    },

    //redis
    {
        name: "REDIS_HOST",
        type: RequiredEnvironmentTypes.String,
    },
    {
        name: "REDIS_PORT",
        type: RequiredEnvironmentTypes.String,
    },
    {
        name: "REDIS_USER",
        type: RequiredEnvironmentTypes.String,
    },
    {
        name: "REDIS_PASSWORD",
        type: RequiredEnvironmentTypes.String,
    },

    // Note: The following are now OPTIONAL (not validated at startup):
    // - Cloudinary (CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET)
    // - ImageKit (IMAGEKIT_PUBLIC_KEY, IMAGEKIT_PRIVATE_KEY, IMAGEKIT_URL)
    // - Dojah (DOJAH_BASE_URL, DOJAH_APP_ID, DOJAH_PUBLIC_KEY, DOJAH_SECRET_KEY, DOJAH_TOKEN_ID)
    // - Quidax (QUIDAX_BASE_URL, QUIDAX_API_PUBLIC, QUIDAX_API_SECRET, QUIDAX_WEBHOOK_KEY, QUIDAX_RAMP_BASEURL)
    // - Paystack (PAYSTACK_SECRET_KEY, PAYSTACK_BASE_URL, PAYSTACK_CANCEL_ACTION, PAYSTACK_CALLBACK_URL)
    // - BLOCKED_COUNTRIES
];

// Log which environment variables are present/missing before validation
const missingVars: string[] = [];
const presentVars: string[] = [];
for (const envVar of runtimeEnvironment) {
    if (process.env[envVar.name]) {
        presentVars.push(envVar.name);
    } else {
        missingVars.push(envVar.name);
    }
}

console.log("=== Environment Variable Check ===");
console.log(`Present (${presentVars.length}):`, presentVars.join(", "));
console.log(`Missing (${missingVars.length}):`, missingVars.join(", "));
console.log("==================================");

if (missingVars.length > 0) {
    console.error(
        `\n❌ FATAL: Missing required environment variables:\n${missingVars.map((v) => `  - ${v}`).join("\n")}\n`
    );
    console.error(
        "Please add these variables to your Render Environment tab.\n"
    );
    // Exit gracefully instead of throwing to get a clean error message
    process.exit(1);
}

try {
    validate(runtimeEnvironment);
} catch (error) {
    console.error("\n❌ Environment validation failed:");
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
}

// App
export const allowedDomains =
    process.env.ALLOWED_DOMAINS && process.env.ALLOWED_DOMAINS.split(",");
export const whitelist: (string | RegExp)[] = allowedDomains ?? [];
export const isProduction: boolean = process.env.NODE_ENV === "production";
export const port: number = parseInt(process.env.PORT ?? "4000");
export const frontendDevUrl = process.env.FRONTEND_DEV_DOMAIN;
// JWT
export const jwtSecret: string = process.env.JWT_SECRET;
export const jwt_refresh_secret: string = process.env.JWT_REFRESH_SECRET;

// Encrypt
export const encryptSecret: string = process.env.ENCRYPT_SECRET;

// Email templates
export interface EMailTemplateConfig {
    registration_success: string;
    verify_account: string;
    forgot_password: string;
    recovery_pin: string;
    transaction_notification: string;
    transaction_failed: string;
}

export const emailTemplateConfig: EMailTemplateConfig = {
    registration_success: process.env.REGISTRATION_SUCCESS_TEMPLATE,
    verify_account: process.env.VERIFY_ACCOUNT_TEMPLATE,
    forgot_password: process.env.FORGOT_PASSWORD_TEMPLATE,
    recovery_pin: process.env.RECOVERY_PIN_TEMPLATE,
    transaction_notification: process.env.TRANSACTION_NOTIFICATION_TEMPLATE,
    transaction_failed: process.env.FAILED_TRANSACTION_TEMPLATE,
};

// Email config
export interface EMailConfig {
    url: string;
    token: string;
    senderMail: string;
}

export const mailConfig: EMailConfig = {
    url: process.env.ZEPTOMAIL_URL,
    token: process.env.ZEPTOMAIL_TOKEN,
    senderMail: process.env.ZEPTOMAIL_SENDER,
};

// Rest of the config remains unchanged...
export const isProdEnvironment = process.env.ENVIRONMENT === "production";
export const frontendDevOrigin = [/^http:\/\/localhost:\d+$/];

interface StorageDirConfig {
    profile: string;
    document: string;
}

export const storageDirConfig: StorageDirConfig = {
    profile: process.env.PROFILE_DIR,
    document: process.env.DOCUMENT_DIR,
};

export interface Configuration {
    emailConfig: EMailConfig;
    isProdEnvironment: boolean;
    isProduction: boolean;
    frontendDevOrigin: RegExp[];
}

//cloudinary (optional - features requiring this will not work without credentials)
export const cloudinaryConfig: ConfigOptions = {
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "",
    api_key: process.env.CLOUDINARY_API_KEY || "",
    api_secret: process.env.CLOUDINARY_API_SECRET || "",
};

//imagekit (optional - features requiring this will not work without credentials)
export interface ImagekitConfig {
    public_key: string;
    private_key: string;
    url: string;
}
export const imagekitConfig: ImagekitConfig = {
    public_key: process.env.IMAGEKIT_PUBLIC_KEY || "",
    private_key: process.env.IMAGEKIT_PRIVATE_KEY || "",
    url: process.env.IMAGEKIT_URL || "",
};

//dojah (optional - identity verification will not work without credentials)
export interface DojahConfig {
    baseUrl: string;
    app_id: string;
    public_key: string;
    secret_key: string;
    token_id: string;
}

export const dojahConfig: DojahConfig = {
    baseUrl: process.env.DOJAH_BASE_URL || "",
    app_id: process.env.DOJAH_APP_ID || "",
    public_key: process.env.DOJAH_PUBLIC_KEY || "",
    secret_key: process.env.DOJAH_SECRET_KEY || "",
    token_id: process.env.DOJAH_TOKEN_ID || "",
};

export interface IdentityComplianceConfig {
    dojah: DojahConfig;
}

export const identityComplianceConfig: IdentityComplianceConfig = {
    dojah: dojahConfig,
};

//quidax (optional - crypto trading will not work without credentials)
export interface QuidaxConfig {
    baseUrl: string;
    rampBaseUrl: string;
    api_public: string;
    api_secret: string;
    webhook_key: string;
}
export const quidaxConfig: QuidaxConfig = {
    baseUrl: process.env.QUIDAX_BASE_URL || "",
    rampBaseUrl: process.env.QUIDAX_RAMP_BASEURL || "",
    api_public: process.env.QUIDAX_API_PUBLIC || "",
    api_secret: process.env.QUIDAX_API_SECRET || "",
    webhook_key: process.env.QUIDAX_WEBHOOK_KEY || "",
};

export interface TradingConfig {
    quidax: QuidaxConfig;
}

export const tradingConfig: TradingConfig = {
    quidax: quidaxConfig,
};

export interface RedisConfig {
    host: string;
    user: string;
    password: string;
    port: number;
    redisOptions: {
        tls: Record<string, any> | undefined;
    };
}

export const redisConfig: RedisConfig = {
    host: process.env.REDIS_HOST,
    password: process.env.REDIS_PASSWORD,
    port: +process.env.REDIS_PORT,
    user: process.env.REDIS_USER,
    redisOptions: {
        tls: {},
    },
};

//payment (optional - payment features will not work without credentials)
export const paystackSecretKey: string = process.env.PAYSTACK_SECRET_KEY || "";

export const paystackOptions: PaystackOptions = {
    baseUrl: process.env.PAYSTACK_BASE_URL || "https://api.paystack.co",
    secretKey: process.env.PAYSTACK_SECRET_KEY || "",
    cancel_action: process.env.PAYSTACK_CANCEL_ACTION || "",
    callback_url: process.env.PAYSTACK_CALLBACK_URL || "",
};

export const blockedCountries: string[] = process.env.BLOCKED_COUNTRIES
    ? process.env.BLOCKED_COUNTRIES.split(",").map((c) =>
          c.trim().toUpperCase()
      )
    : [];

// Termii SMS (optional - SMS features will not work without credentials)
export interface TermiiConfig {
    apiKey: string;
    secretKey: string;
    senderId: string;
    baseUrl?: string;
}

export const termiiConfig: TermiiConfig = {
    apiKey: process.env.TERMII_API_KEY || "",
    secretKey: process.env.TERMII_SECRET_KEY || "",
    senderId: process.env.TERMII_SENDER_ID || "Flipxer",
    baseUrl: process.env.TERMII_BASE_URL || "https://v3.api.termii.com",
};

export const termiiOptions: TermiiOptions = {
    apiKey: termiiConfig.apiKey,
    baseUrl: termiiConfig.baseUrl,
};

export interface Configuration {
    redisConfig: RedisConfig;
    tradingConfig: TradingConfig;
    identityComplianceConfig: IdentityComplianceConfig;
    imagekitConfig: ImagekitConfig;
    mailConfig: EMailConfig;
    emailTemplateConfig: EMailTemplateConfig;
    paystackConfig: PaystackOptions;
}
