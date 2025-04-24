import { config } from "dotenv";
import validate, {
    RequiredEnvironment,
    RequiredEnvironmentTypes,
} from "@boxpositron/vre";
import { ConfigOptions } from "cloudinary";

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
        name: "RECOVERY_PIN_TEMPLATE", // Added for recovery PIN email
        type: RequiredEnvironmentTypes.String,
    },
    // Rest of the existing entries...
    {
        name: "JWT_SECRET",
        type: RequiredEnvironmentTypes.String,
    },
    // ... (keeping the rest unchanged)
];

validate(runtimeEnvironment);

// App
export const allowedDomains = process.env.ALLOWED_DOMAINS && process.env.ALLOWED_DOMAINS.split(",");
export const isProduction: boolean = process.env.NODE_ENV === "production";
export const port: number = parseInt(process.env.PORT ?? "4000");

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
    recovery_pin: string; // Added for recovery PIN
}

export const emailTemplateConfig: EMailTemplateConfig = {
    registration_success: process.env.REGISTRATION_SUCCESS_TEMPLATE,
    verify_account: process.env.VERIFY_ACCOUNT_TEMPLATE,
    forgot_password: process.env.FORGOT_PASSWORD_TEMPLATE,
    recovery_pin: process.env.RECOVERY_PIN_TEMPLATE, // Added
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

//cloudinary
export const cloudinaryConfig: ConfigOptions = {
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
};

//imagekit
export interface ImagekitConfig {
    public_key: string;
    private_key: string;
    url: string;
}
export const imagekitConfig: ImagekitConfig = {
    public_key: process.env.IMAGEKIT_PUBLIC_KEY,
    private_key: process.env.IMAGEKIT_PRIVATE_KEY,
    url: process.env.IMAGEKIT_URL,
};

//dojah
export interface DojahConfig {
    baseUrl: string;
    app_id: string;
    public_key: string;
    secret_key: string;
    token_id: string;
}

export const dojahConfig: DojahConfig = {
    baseUrl: process.env.DOJAH_BASE_URL,
    app_id: process.env.DOJAH_APP_ID,
    public_key: process.env.DOJAH_PUBLIC_KEY,
    secret_key: process.env.DOJAH_SECRET_KEY,
    token_id: process.env.DOJAH_TOKEN_ID,
};

export interface IdentityComplianceConfig {
    dojah: DojahConfig;
}

export const identityComplianceConfig: IdentityComplianceConfig = {
    dojah: dojahConfig,
};
