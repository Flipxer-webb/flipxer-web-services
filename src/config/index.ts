import { config } from "dotenv";

import validate, {
    RequiredEnvironment,
    RequiredEnvironmentTypes,
} from "@boxpositron/vre";
import { ConfigOptions } from "cloudinary";

export * from "./constants";

config();

const runtimeEnvironment: RequiredEnvironment[] = [
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

    //mail
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
    //templates
    {
        name: "REGISTRATION_SUCCESS_TEMPLATE",
        type: RequiredEnvironmentTypes.Number,
    },
    {
        name: "VERIFY_ACCOUNT_TEMPLATE",
        type: RequiredEnvironmentTypes.Number,
    },
    {
        name: "FORGOT_PASSWORD_TEMPLATE",
        type: RequiredEnvironmentTypes.Number,
    },

    // secret
    {
        name: "JWT_SECRET",
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

    //clodinary
    {
        name: "CLOUDINARY_CLOUD_NAME",
        type: RequiredEnvironmentTypes.String,
    },
    {
        name: "CLOUDINARY_API_KEY",
        type: RequiredEnvironmentTypes.String,
    },
    {
        name: "CLOUDINARY_API_SECRET",
        type: RequiredEnvironmentTypes.String,
    },
    //imagekit
    {
        name: "IMAGEKIT_PUBLIC_KEY",
        type: RequiredEnvironmentTypes.String,
    },
    {
        name: "IMAGEKIT_PRIVATE_KEY",
        type: RequiredEnvironmentTypes.String,
    },
    {
        name: "IMAGEKIT_URL",
        type: RequiredEnvironmentTypes.String,
    },
    //dojah
    {
        name: "DOJAH_BASE_URL",
        type: RequiredEnvironmentTypes.String,
    },
    {
        name: "DOJAH_APP_ID",
        type: RequiredEnvironmentTypes.String,
    },
    {
        name: "DOJAH_PUBLIC_KEY",
        type: RequiredEnvironmentTypes.String,
    },
    {
        name: "DOJAH_SECRET_KEY",
        type: RequiredEnvironmentTypes.String,
    },
    {
        name: "DOJAH_TOKEN_ID",
        type: RequiredEnvironmentTypes.String,
    },
    {
        name: "QUIDAX_BASE_URL",
        type: RequiredEnvironmentTypes.String,
    },
    {
        name: "QUIDAX_API_PUBLIC",
        type: RequiredEnvironmentTypes.String,
    },
    {
        name: "QUIDAX_API_SECRET",
        type: RequiredEnvironmentTypes.String,
    },
    {
        name: "QUIDAX_WEBHOOK_KEY",
        type: RequiredEnvironmentTypes.String,
    },
    //server environment
    {
        name: "ENVIRONMENT",
        type: RequiredEnvironmentTypes.String,
    },
];

validate(runtimeEnvironment);

//app
export const allowedDomains =
    process.env.ALLOWED_DOMAINS && process.env.ALLOWED_DOMAINS.split(",");
export const isProduction: boolean = process.env.NODE_ENV === "production";
export const port: number = parseInt(process.env.PORT ?? "4000");

//jwt
export const jwtSecret: string = process.env.JWT_SECRET;
export const jwt_refresh_secret: string = process.env.JWT_REFRESH_SECRET;

//encrypt
export const encryptSecret: string = process.env.ENCRYPT_SECRET;

//email templates
export interface EMailTemplateConfig {
    registration_success: string;
    verify_account: string;
    forgot_password: string;
}

export const emailTemplateConfig: EMailTemplateConfig = {
    registration_success: process.env.REGISTRATION_SUCCESS_TEMPLATE,
    verify_account: process.env.VERIFY_ACCOUNT_TEMPLATE,
    forgot_password: process.env.FORGOT_PASSWORD_TEMPLATE,
};

//email config
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

//prod deployment env
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

//quidax
export interface QuidaxConfig {
    baseUrl: string;
    api_public: string;
    api_secret: string;
    webhook_key: string;
}
export const quidaxConfig: QuidaxConfig = {
    baseUrl: process.env.QUIDAX_BASE_URL,
    api_public: process.env.QUIDAX_API_PUBLIC,
    api_secret: process.env.QUIDAX_API_SECRET,
    webhook_key: process.env.QUIDAX_WEBHOOK_KEY,
};

export interface TradingConfig {
    quidax: QuidaxConfig;
}

export const tradingConfig: TradingConfig = {
    quidax: quidaxConfig,
};
