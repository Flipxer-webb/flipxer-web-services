import { 
    User,
    Status,
    UserType,
    DocumentVerificationStatus
} from "@prisma/client";
import { Request } from "express";
import { UserSigInDto } from "../dtos";


export interface DataStoredInToken {
    sub: string;
}

export interface RequestWithUser extends Request {
    user: User;
}

export enum LoginPlatform {
    ADMIN = "ADMIN", // Admin sign-in platform
    USER = "USER", // individual and business sign-in platform
}

export type SignInOptions = UserSigInDto;

interface QuidaxHeader {
    ["quidax-signature"]: string;
}

export type RequestFromQuidax = Request & {
    headers: QuidaxHeader;
};

export interface UploadBusinessDocumentsFileInterface {
    cacImage?: Express.Multer.File[];
    articleOfAssociationImage?: Express.Multer.File[];
    boardResolutionAuthorizedAcctOpeningImage?: Express.Multer.File[];
    proofOfAddressForBeneficialOwner?: Express.Multer.File[];
    meansOfIdentificationForBeneficialOwner?: Express.Multer.File[];
}

export interface DocumentVerificationFileInterface {
    documentImage1?: Express.Multer.File[];
    documentImage2?: Express.Multer.File[];
}

interface PaystackHeader {
    ["x-paystack-signature"]: string;
}

export interface VerificationStatus {
    isEmailVerified: boolean;
    isPhoneVerified: boolean;
    isPasswordCreated: boolean;
    isBvnVerified: boolean;
    isDocumentVerified: boolean;
    businessRecordCompleted?: boolean;
    businessDocumentVerificationStatus?: string | null;
}

// Custom type for signIn query result
export interface SignInUser {
    id: number;
    identifier: string;
    password: string;
    userType: UserType;
    status: Status;
    role: { name: string; rolePermission: any[] };
    lastLogin: Date | null;
    loginCount: number | null;
    flaggedRecord: { flagged: boolean; reason: string } | null;
    flaggedId: number | null;
    email: string;
    isEmailVerified: boolean;
    isPhoneVerified: boolean;
    isPasswordCreated: boolean;
    isBvnVerified: boolean;
    isDocumentVerified: boolean;
    businessRecordCompleted: boolean;
    businessDocumentVerificationStatus: DocumentVerificationStatus | null;
}

export type RequestFromPaystack = Request & { headers: PaystackHeader };

export const DocumentMetaMap = {
    cacImage: "CAC",
    articleOfAssociationImage: "Article Of Association",
    boardResolutionAuthorizedAcctOpeningImage:
        "Board Resolution Authorized Acct Opening",
    proofOfAddressForBeneficialOwner: "Proof Of Address For Beneficial Owner",
    meansOfIdentificationForBeneficialOwner:
        "Means Of Identification For Beneficial Owner",
} as const;


export enum SupportedAssets {
    BTC = 'BTC',
    ETH = 'ETH',
    USDT = 'USDT',
    USDC = 'USDC',
    BNB = 'BNB',
    SOL = 'SOL',
    XRP = 'XRP',
    ADA = 'ADA',
    DOT = 'DOT',
    DOGE = 'DOGE',
    SHIB = 'SHIB',
    MATIC = 'MATIC',
    LINK = 'LINK',
    LTC = 'LTC',
    BCH = 'BCH',
    XLM = 'XLM',
    ALGO = 'ALGO',
    AAVE = 'AAVE',
    FIL = 'FIL',
    CAKE = 'CAKE',
    MANA = 'MANA',
    SAND = 'SAND',
    FTM = 'FTM',
    XTZ = 'XTZ',
    APE = 'APE',
    ENS = 'ENS',
    ARB = 'ARB',
    OP = 'OP',
    ICP = 'ICP',
    SUI = 'SUI'
}