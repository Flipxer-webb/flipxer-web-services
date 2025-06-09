import { User } from "@prisma/client";
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

export type RequestFromPaystack = Request & { headers: PaystackHeader };
