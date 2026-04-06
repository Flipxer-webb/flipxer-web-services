import { config } from "dotenv";
import validate, {
    RequiredEnvironment,
    RequiredEnvironmentTypes,
} from "@boxpositron/vre";
import { ConfigOptions } from "cloudinary";
import { SendchampOptions } from "@/libs/sendchamp";

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
        name: "ADMIN_INVITE_TEMPLATE",
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

     // SECURITY: QUIDAX_WEBHOOK_KEY is required - without it, all Quidax webhooks
     // are rejected and crypto deposits/withdrawals/swaps will never fulfill.
    {
        name: "QUIDAX_WEBHOOK_KEY",
        type: RequiredEnvironmentTypes.String,
    },
    // SECURITY: NOMBA_WEBHOOK_SECRET is required - without it, all Nomba webhooks
    // are rejected and fiat payment confirmations will never fulfill BUY orders.
    {
        name: "NOMBA_WEBHOOK_SECRET",
        type: RequiredEnvironmentTypes.String,
    },
     // FRONTEND_URL is required - used for CORS, email links, and redirect URLs.
    // Hardcoded fallback removed to prevent accidental cross-environment leakage.
    {
        name: "FRONTEND_URL",
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

if (process.env.NODE_ENV !== 'test' && missingVars.length > 0) {
    const varList = missingVars.map((v) => `  - ${v}`).join("\n");
    console.error(`\n❌ FATAL: Missing required environment variables:\n${varList}\n`);
    console.error(
        "Please add these variables to your Render Environment tab.\n"
    );
    // Exit gracefully instead of throwing to get a clean error message
    process.exit(1);
}

if (process.env.NODE_ENV !== 'test') {
    try {
        validate(runtimeEnvironment);
    } catch (error) {
        console.error("\n❌ Environment validation failed:");
        console.error("Error:", error instanceof Error ? error.message : error);
        process.exit(1);
    }
}

// App
export const allowedDomains =
    process.env.ALLOWED_DOMAINS?.split(",");
export const whitelist: (string | RegExp)[] = allowedDomains ?? [];
export const isProduction: boolean = process.env.ENVIRONMENT === "production";
export const port: number = Number.parseInt(process.env.PORT ?? "4000");
export const frontendDevUrl = process.env.FRONTEND_DEV_DOMAIN;
export const frontendUrl = process.env.FRONTEND_URL;
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
    document_approved: string;
    document_rejected: string;
    admin_invite: string;
    transaction_otp: string;
}

export const emailTemplateConfig: EMailTemplateConfig = {
    registration_success: process.env.REGISTRATION_SUCCESS_TEMPLATE,
    verify_account: process.env.VERIFY_ACCOUNT_TEMPLATE,
    forgot_password: process.env.FORGOT_PASSWORD_TEMPLATE,
    recovery_pin: process.env.RECOVERY_PIN_TEMPLATE,
    transaction_notification: process.env.TRANSACTION_NOTIFICATION_TEMPLATE,
    transaction_failed: process.env.FAILED_TRANSACTION_TEMPLATE,
    document_approved: process.env.DOCUMENT_APPROVED_TEMPLATE || "",
    document_rejected: process.env.DOCUMENT_REJECTED_TEMPLATE || "",
    admin_invite: process.env.ADMIN_INVITE_TEMPLATE || "",
    transaction_otp: process.env.TRANSACTION_OTP_TEMPLATE || "",
};

// Email config
export interface EMailConfig {
    url: string;
    token: string;
    senderMail: string;
}

const normalizeZeptoMailUrl = (rawUrl?: string): string => {
    const value = (rawUrl || "").trim();

    if (!value) {
        return value;
    }

    // ZeptoMail SDK expects a host/base URL. If /v1.1 is provided,
    // strip API path so template requests resolve to /v1.1/email/template.
    if (!/\/v1\.1(\/|$)/i.test(value)) {
        return value;
    }

    const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;

    try {
        const parsed = new URL(candidate);
        return `${parsed.host}/`;
    } catch {
        return value;
    }
};

export const mailConfig: EMailConfig = {
    url: normalizeZeptoMailUrl(process.env.ZEPTOMAIL_URL),
    token: process.env.ZEPTOMAIL_TOKEN,
    senderMail: process.env.ZEPTOMAIL_SENDER?.trim(),
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
    mainAccountId: string;
}
export const quidaxConfig: QuidaxConfig = {
    baseUrl: process.env.QUIDAX_BASE_URL || "",
    rampBaseUrl: process.env.QUIDAX_RAMP_BASEURL || "",
    api_public: process.env.QUIDAX_API_PUBLIC || "",
    api_secret: process.env.QUIDAX_API_SECRET || "",
    webhook_key: process.env.QUIDAX_WEBHOOK_KEY || "",
    mainAccountId: process.env.QUIDAX_MAIN_ACCOUNT_ID || "",
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
        tls: process.env.REDIS_TLS === "true" ? {} : undefined,
    },
};

// fincra
export interface FincraOptions {
    baseUrl: string;
    secretKey: string;
    publicKey: string;
    businessId?: string;
    redirectUrl?: string;
    webhookSecret?: string;
    proxyUrl?: string; // Optional proxy URL for IP whitelisting
}

export const fincraOptions: FincraOptions = {
    baseUrl: process.env.FINCRA_BASE_URL || "https://api.fincra.com",
    secretKey: process.env.FINCRA_SECRET_KEY || "",
    publicKey: process.env.FINCRA_PUBLIC_KEY || "",
    businessId: process.env.FINCRA_BUSINESS_ID || "",
    redirectUrl: process.env.FINCRA_REDIRECT_URL || process.env.PAYSTACK_CALLBACK_URL || "",
    webhookSecret: process.env.FINCRA_WEBHOOK_SECRET || "",
    proxyUrl: process.env.FINCRA_PROXY_URL || "", // e.g., http://user:pass@proxy.quotaguard.com:9293
};

export const blockedCountries: string[] = process.env.BLOCKED_COUNTRIES
    ? process.env.BLOCKED_COUNTRIES.split(",").map((c) =>
        c.trim().toUpperCase()
    )
    : [];

// Firebase (optional - push notifications will not work without credentials)
export interface FirebaseConfig {
    projectId: string;
    clientEmail: string;
    privateKey: string;
}

export const firebaseConfig: FirebaseConfig = {
    projectId: process.env.FIREBASE_PROJECT_ID || "",
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL || "",
    privateKey: process.env.FIREBASE_PRIVATE_KEY || "",
};

// Sendchamp SMS (optional - SMS features will not work without credentials)
export interface SendchampConfig {
    accessKey: string;
    senderId: string;
    baseUrl?: string;
}

export const sendchampConfig: SendchampConfig = {
    accessKey: process.env.SENDCHAMP_ACCESS_KEY || "",
    senderId: process.env.SENDCHAMP_SENDER_ID || "Flipxer",
    baseUrl: process.env.SENDCHAMP_BASE_URL || "https://api.sendchamp.com/api/v1",
};

export const sendchampOptions: SendchampOptions = {
    accessKey: sendchampConfig.accessKey,
    baseUrl: sendchampConfig.baseUrl,
};

export interface Configuration {
    redisConfig: RedisConfig;
    tradingConfig: TradingConfig;
    identityComplianceConfig: IdentityComplianceConfig;
    imagekitConfig: ImagekitConfig;
    mailConfig: EMailConfig;
    emailTemplateConfig: EMailTemplateConfig;
    fincraConfig: FincraOptions;
}

// Nomba (optional - alternative fiat gateway alongside Fincra)
export interface NombaOptions {
    baseUrl: string;
    clientId: string;
    clientSecret: string;
    accountId: string;
    webhookSecret?: string;
}

export const nombaOptions: NombaOptions = {
    baseUrl: process.env.NOMBA_BASE_URL || "https://api.nomba.com",
    clientId: process.env.NOMBA_CLIENT_ID || "",
    clientSecret: process.env.NOMBA_CLIENT_SECRET || "",
    accountId: process.env.NOMBA_ACCOUNT_ID || "",
    webhookSecret: process.env.NOMBA_WEBHOOK_SECRET || "",
};

// Slack webhook for payout failure alerts (optional)
export const slackPayoutAlertWebhookUrl = process.env.SLACK_PAYOUT_ALERT_WEBHOOK_URL || "";

