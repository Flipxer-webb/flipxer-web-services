import { ApiProperty } from "@nestjs/swagger";
import { Country, DocumentType } from "@prisma/client";
import {
    IsAlphanumeric,
    IsBase64,
    IsEmail,
    IsEnum,
    IsNotEmpty,
    IsNumber,
    IsNumberString,
    IsOptional,
    IsPhoneNumber,
    IsString,
    Length,
    Matches,
    MaxLength,
    MinLength,
} from "class-validator";
import { Type } from "class-transformer";

enum Gender {
    MALE = "MALE",
    FEMALE = "FEMALE",
}

export class SendEmailVerificationCodeDto {
    @ApiProperty()
    @IsNotEmpty()
    @IsEmail({}, { message: "Invalid email address" })
    email: string;
}

export class VerifyEmailOtpDto {
    @ApiProperty()
    @IsNotEmpty()
    @IsEmail({}, { message: "Invalid email address" })
    email: string;

    @ApiProperty()
    @IsNotEmpty()
    @IsNumberString({}, { message: "Invalid otp" })
    @IsNotEmpty({ message: "Otp must not be empty" })
    otp: string;
}

export class VerifyPhoneOtpDto {
    @ApiProperty()
    @IsNotEmpty()
    @IsPhoneNumber("NG")
    @Length(11, 11, { message: "Phone number must be 11 digits" })
    phone: string;

    @ApiProperty()
    @IsNotEmpty()
    @IsNumberString({}, { message: "Invalid otp" })
    @IsNotEmpty({ message: "Otp must not be empty" })
    otp: string;
}

export class CreatePasswordDto {
    @ApiProperty()
    @IsNotEmpty()
    @IsString()
    @MinLength(8, { message: "Password must be at least 8 characters long" })
    @MaxLength(100, { message: "Password must not exceed 100 characters" })
    @Matches(/^(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9])[A-Za-z\d\S]+$/, {
        message:
            "Password must contain at least one uppercase letter, one number, and one special character",
    })
    password: string;
}

export class SendForgotPasswordDto {
    @ApiProperty()
    @IsNotEmpty()
    @IsEmail({}, { message: "Invalid email address" })
    email: string;
}

export class ResetPasswordDto extends CreatePasswordDto {
    @ApiProperty()
    @IsNotEmpty()
    @IsEmail({}, { message: "Invalid email address" })
    email: string;

    @ApiProperty()
    @IsNotEmpty()
    @IsString()
    resetCode: string;
}

export class Verify2FALoginDto {
    @ApiProperty({ description: "Temporary token received from login" })
    @IsNotEmpty()
    @IsString()
    tempToken: string;

    @ApiProperty({ description: "6-digit TOTP code from authenticator app" })
    @IsNotEmpty()
    @Matches(/^\d{6}$/, { message: "TOTP code must be 6 digits" })
    code: string;

    @ApiProperty({ required: false, description: "Device name for session tracking" })
    @IsString()
    @IsOptional()
    deviceName?: string;

    @ApiProperty({ required: false, description: "Device type (mobile, desktop, tablet)" })
    @IsString()
    @IsOptional()
    deviceType?: string;

    @ApiProperty({ required: false, description: "Browser name" })
    @IsString()
    @IsOptional()
    browser?: string;

    @ApiProperty({ required: false, description: "Operating system" })
    @IsString()
    @IsOptional()
    os?: string;
}

enum AccountType {
    INDIVIDUAL = "INDIVIDUAL",
    BUSINESS = "BUSINESS",
}

export class SignUpDto {
    @ApiProperty({ enum: AccountType, enumName: "AccountType" })
    @IsNotEmpty()
    @IsEnum(AccountType)
    accountType: AccountType;

    @ApiProperty()
    @IsNotEmpty()
    @IsEmail({}, { message: "Invalid email address" })
    email: string;

    @ApiProperty()
    @IsNotEmpty()
    @IsString()
    firstName: string;

    @ApiProperty()
    @IsNotEmpty()
    @IsString()
    lastName: string;

    @ApiProperty({
        description: "Date of Birth in YYYY-MM-DD format",
    })
    @IsNotEmpty()
    @IsString()
    dateOfBirth: string;

    @ApiProperty({
        description: "Optional Flagged record ID for the user",
        required: false,
    })
    @IsOptional()
    @IsNumber({}, { message: "Flagged ID must be a number" })
    @Type(() => Number) // Ensure string-to-number conversion for JSON input
    flaggedId?: number;
}

export class BvnVerificationDto {
    @ApiProperty()
    @IsNotEmpty()
    @IsString()
    firstName: string;

    @ApiProperty()
    @IsNotEmpty()
    @IsString()
    lastName: string;

    @ApiProperty({
        description: "Date of Birth in YYYY-MM-DD format",
        example: "2024-06-01",
        format: "date",
    })
    @IsNotEmpty()
    @Matches(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/, {
        message:
            "Date of Birth must be in YYYY-MM-DD format (e.g., 2024-06-01)",
    })
    dateOfBirth: string;

    @ApiProperty({
        description: "user bvn",
        example: "use 22222222222 for sandbox bvn testing",
    })
    @IsNotEmpty()
    @IsNumberString()
    @Length(11, 11, { message: "Bvn number must be 11 digits" })
    bvn: string;
}

export class NinVerificationDto {
    @ApiProperty()
    @IsNotEmpty()
    @IsString()
    firstName: string;

    @ApiProperty()
    @IsNotEmpty()
    @IsString()
    lastName: string;

    @ApiProperty({
        description: "Date of Birth in YYYY-MM-DD format",
        example: "2024-06-01",
        format: "date",
    })
    @IsNotEmpty()
    @Matches(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/, {
        message:
            "Date of Birth must be in YYYY-MM-DD format (e.g., 2024-06-01)",
    })
    dateOfBirth: string;

    @ApiProperty({
        description: "user NIN",
        example: "use 00000000001 for sandbox NIN testing",
    })
    @IsNotEmpty()
    @IsNumberString()
    @Length(11, 11, { message: "NIN must be 11 digits" })
    nin: string;
}

export class OnboardIndividualDto {
    @ApiProperty()
    @IsNotEmpty()
    @IsString()
    firstName: string;

    @ApiProperty()
    @IsNotEmpty()
    @IsString()
    lastName: string;

    @ApiProperty({
        description: "Date of Birth in YYYY-MM-DD format",
        example: "2024-06-01",
        format: "date",
    })
    @IsNotEmpty()
    @Matches(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/, {
        message:
            "Date of Birth must be in YYYY-MM-DD format (e.g., 2024-06-01)",
    })
    dateOfBirth: string;
}

export class SignInDto {
    @ApiProperty()
    @IsEmail({}, { message: "Invalid email address" })
    email: string;

    @ApiProperty()
    @IsString({ message: "Invalid password format" })
    password: string;

    @ApiProperty({ required: false, description: "Device name for session tracking" })
    @IsString()
    @IsOptional()
    deviceName?: string;

    @ApiProperty({ required: false, description: "Device type (mobile, desktop, tablet)" })
    @IsString()
    @IsOptional()
    deviceType?: string;

    @ApiProperty({ required: false, description: "Browser name" })
    @IsString()
    @IsOptional()
    browser?: string;

    @ApiProperty({ required: false, description: "Operating system" })
    @IsString()
    @IsOptional()
    os?: string;
}

export enum UserSignInAppType {
    USER = "USER",
    ADMIN = "ADMIN",
}

export class UserSigInDto extends SignInDto {}

export class SendPhoneVerificationCodeDto {
    @ApiProperty()
    @IsNotEmpty()
    @IsPhoneNumber("NG")
    @Length(11, 11, { message: "Phone number must be 11 digits" })
    phone: string;
}

export class DocumentVerificationDto {
    @ApiProperty({ enum: DocumentType, enumName: "DocumentType" })
    @IsNotEmpty()
    @IsEnum(DocumentType)
    documentType: DocumentType;

    @ApiProperty({ enum: Country, enumName: "Country" })
    @IsNotEmpty()
    @IsEnum(Country)
    country: Country;

    @ApiProperty()
    @IsNotEmpty()
    @IsString()
    documentNumber: string;
}

export class DocumentVerificationUploadFormDto {
    @ApiProperty({ enum: DocumentType, enumName: "DocumentType" })
    @IsNotEmpty()
    @IsEnum(DocumentType)
    documentType: DocumentType;

    @ApiProperty({ enum: Country, enumName: "Country" })
    @IsNotEmpty()
    @IsEnum(Country)
    country: Country;

    @ApiProperty()
    @IsNotEmpty()
    @IsString()
    documentNumber: string;

    @ApiProperty({
        type: "string",
        format: "binary",
        description: "Document image file",
    })
    documentImage1: any;

    @ApiProperty({
        required: false,
        type: "string",
        format: "binary",
        description: "Document image file",
    })
    documentImage2?: any;
}

export class BusinessDocumentUploadDto {
    @ApiProperty({ description: "A valid CAC document number" })
    @IsNotEmpty()
    cacDocumentNumber: string;

    @ApiProperty({
        description: "A valid article of association number",
        required: false,
    })
    @IsOptional()
    articleOfAssociationNumber?: string;
}

export class BusinessDocumentUploadFormDto {
    @ApiProperty({ type: "string", description: "CAC document number" })
    cacDocumentNumber: string;

    @ApiProperty({
        type: "string",
        required: false,
        description: "Article of Association number",
    })
    articleOfAssociationNumber?: string;

    @ApiProperty({
        type: "string",
        format: "binary",
        description: "CAC document image file",
    })
    cacImage: any;

    @ApiProperty({
        type: "string",
        format: "binary",
        description: "Article of Association image file",
        required: false,
    })
    articleOfAssociationImage?: any;

    @ApiProperty({
        type: "string",
        format: "binary",
        description: "Board resolution image file",
        required: false,
    })
    boardResolutionAuthorizedAcctOpeningImage?: any;

    @ApiProperty({
        type: "string",
        format: "binary",
        description: "Proof of address for beneficial owner",
        required: false,
    })
    proofOfAddressForBeneficialOwner?: any;

    @ApiProperty({
        type: "string",
        format: "binary",
        description: "Means of identification for beneficial owner",
        required: false,
    })
    meansOfIdentificationForBeneficialOwner?: any;
}

export class SubmitBusinessRecordDto {
    @ApiProperty()
    @IsNotEmpty()
    @IsString()
    firstName: string;

    @ApiProperty()
    @IsNotEmpty()
    @IsString()
    lastName: string;

    @ApiProperty()
    @IsNotEmpty()
    @IsString()
    businessName: string;

    @ApiProperty()
    @IsNotEmpty()
    @IsString()
    natureOfBusiness: string;

    @ApiProperty()
    @IsNotEmpty()
    @IsAlphanumeric()
    taxIdentificationNumber: string;

    @ApiProperty()
    @IsNotEmpty()
    @IsString()
    expectedTransactionVolumes: string;

    @ApiProperty()
    @IsNotEmpty()
    @IsString()
    expectedTransactionFrequency: string;
}

export class RefreshTokenDto {
    @ApiProperty()
    @IsNotEmpty()
    @IsString()
    refreshToken: string;
}

// ==================== Tier 2/3 Verification DTOs ====================

export class VerifyAddressUploadFormDto {
    @ApiProperty({ type: "string", format: "binary", description: "Address proof document (utility bill, bank statement)" })
    document: Express.Multer.File;
}

export class VerifyIncomeUploadFormDto {
    @ApiProperty({ type: "string", format: "binary", description: "Income proof document (payslip, bank statement, tax document)" })
    document: Express.Multer.File;
}

export class RegisterBiometricDto {
    @ApiProperty({ description: "WebAuthn credential ID (base64 encoded)" })
    @IsNotEmpty()
    @IsString()
    credentialId: string;

    @ApiProperty({ description: "WebAuthn public key (base64 encoded)" })
    @IsNotEmpty()
    @IsString()
    publicKey: string;

    @ApiProperty({ description: "Device name for identification", required: false })
    @IsOptional()
    @IsString()
    deviceName?: string;
}

export class VerifyBiometricDto {
    @ApiProperty({ description: "WebAuthn credential ID (base64 encoded)", required: false })
    @IsOptional()
    @IsString()
    credentialId?: string;

    @ApiProperty({ description: "WebAuthn signature (base64 encoded)", required: false })
    @IsOptional()
    @IsString()
    signature?: string;

    @ApiProperty({ description: "WebAuthn authenticator data (base64 encoded)", required: false })
    @IsOptional()
    @IsString()
    authenticatorData?: string;

    @ApiProperty({ description: "WebAuthn client data JSON (base64 encoded)", required: false })
    @IsOptional()
    @IsString()
    clientDataJSON?: string;

    @ApiProperty({ description: "Trading password as fallback for biometric", required: false })
    @IsOptional()
    @IsString()
    @MinLength(6, { message: "Trading password must be at least 6 characters" })
    tradingPassword?: string;

    @ApiProperty({ description: "Use trading password instead of biometric", required: false })
    @IsOptional()
    useTradingPassword?: boolean;
}

export class CreateTradingPasswordDto {
    @ApiProperty({ description: "Trading password (6+ characters)" })
    @IsNotEmpty()
    @IsString()
    @MinLength(6, { message: "Trading password must be at least 6 characters" })
    @MaxLength(50, { message: "Trading password must not exceed 50 characters" })
    tradingPassword: string;

    @ApiProperty({ description: "Confirm trading password" })
    @IsNotEmpty()
    @IsString()
    confirmTradingPassword: string;
}

export class BiometricLoginDto {
    @ApiProperty({ description: "WebAuthn credential ID (base64 encoded)" })
    @IsNotEmpty()
    @IsString()
    credentialId: string;

    @ApiProperty({ description: "WebAuthn signature (base64 encoded)" })
    @IsNotEmpty()
    @IsString()
    signature: string;

    @ApiProperty({ description: "WebAuthn authenticator data (base64 encoded)" })
    @IsNotEmpty()
    @IsString()
    authenticatorData: string;

    @ApiProperty({ description: "WebAuthn client data JSON (base64 encoded)" })
    @IsNotEmpty()
    @IsString()
    clientDataJSON: string;

    @ApiProperty({ description: "Temporary token received from login" })
    @IsNotEmpty()
    @IsString()
    tempToken: string;
}

