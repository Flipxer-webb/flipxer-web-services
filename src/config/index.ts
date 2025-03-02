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
        name: "MAIL_SMTP_HOST",
        type: RequiredEnvironmentTypes.String,
    },
    {
        name: "MAIL_SMTP_PORT",
        type: RequiredEnvironmentTypes.Number,
    },
    {
        name: "MAIL_SMTP_USER",
        type: RequiredEnvironmentTypes.String,
    },
    {
        name: "MAIL_SMTP_PASSWORD",
        type: RequiredEnvironmentTypes.String,
    },
    {
        name: "MAIL_SENDER_NAME",
        type: RequiredEnvironmentTypes.String,
    },
    {
        name: "MAIL_SENDER_EMAIL",
        type: RequiredEnvironmentTypes.String,
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
export interface EMailConfig {
    host: string;
    port: number;
    user: string;
    pass: string;
    senderName: string;
    senderEmail: string;
}

export const mailConfig: EMailConfig = {
    host: process.env.MAIL_SMTP_HOST,
    port: +process.env.MAIL_SMTP_PORT,
    user: process.env.MAIL_SMTP_USER,
    pass: process.env.MAIL_SMTP_PASSWORD,
    senderName: process.env.MAIL_SENDER_NAME,
    senderEmail: process.env.MAIL_SENDER_EMAIL,
};

//prod deployment env
export const isProdEnvironment = process.env.ENVIRONMENT === "production";

export const frontendDevOrigin = [/^http:\/\/localhost:\d+$/];

interface StorageDirConfig {
    profile: string;
}

export const storageDirConfig: StorageDirConfig = {
    profile: process.env.PROFILE_DIR,
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
