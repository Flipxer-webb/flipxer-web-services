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

export class UserSigInDto extends SignInDto { }

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

/**
 * DTO for base64-encoded document verification
 * Optimized for Dojah API integration - accepts base64 images directly
 */
export class DocumentVerificationBase64Dto {
    @ApiProperty({ enum: DocumentType, enumName: "DocumentType" })
    @IsNotEmpty()
    @IsEnum(DocumentType)
    documentType: DocumentType;

    @ApiProperty({ enum: Country, enumName: "Country" })
    @IsNotEmpty()
    @IsEnum(Country)
    country: Country;

    @ApiProperty({ description: "Document number (e.g., passport number, license number)" })
    @IsNotEmpty()
    @IsString()
    documentNumber: string;

    @ApiProperty({
        description: "Base64-encoded front image of the document (without data:image prefix)",
    })
    @IsNotEmpty()
    @IsString()
    imageFrontBase64: string;

    @ApiProperty({
        required: false,
        description: "Base64-encoded back image of the document (without data:image prefix)",
    })
    @IsOptional()
    @IsString()
    imageBackBase64?: string;
}

/**
 * DTO for document preview/pre-validation
 * Calls Dojah to analyze document WITHOUT saving to database
 * Returns extracted data for user to verify before final submission
 */
export class DocumentPreviewDto {
    @ApiProperty({
        description: "Base64-encoded front image of the document",
    })
    @IsNotEmpty()
    @IsString()
    imageFrontBase64: string;

    @ApiProperty({
        required: false,
        description: "Base64-encoded back image of the document",
    })
    @IsOptional()
    @IsString()
    imageBackBase64?: string;
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

export class UploadBusinessDocumentFileDto {
    @ApiProperty({
        description:
            "Field name identifying which document this is: cacImage, articleOfAssociationImage, boardResolutionAuthorizedAcctOpeningImage, proofOfAddressForBeneficialOwner, meansOfIdentificationForBeneficialOwner",
    })
    @IsNotEmpty()
    @IsString()
    fieldName: string;
}

export class UploadBusinessDocumentFileFormDto {
    @ApiProperty({ type: "string", description: "Document field name" })
    fieldName: string;

    @ApiProperty({
        type: "string",
        format: "binary",
        description: "The document file",
    })
    file: any;
}

export class SubmitBusinessDocumentsDto {
    @ApiProperty({ description: "A valid CAC document number" })
    @IsNotEmpty()
    cacDocumentNumber: string;

    @ApiProperty({
        description: "A valid article of association number",
        required: false,
    })
    @IsOptional()
    articleOfAssociationNumber?: string;

    @ApiProperty({
        description:
            "Map of fieldName → ImageKit URL for each uploaded file",
    })
    @IsNotEmpty()
    uploadedFiles: Record<string, { url: string; fileId: string; originalName?: string }>;
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

export class Reset2FARateLimitDto {
    @ApiProperty({ example: 123, description: "User ID to reset rate limit for" })
    @IsNotEmpty()
    @IsNumber()
    userId: number;

    @ApiProperty({
        example: "login",
        description: "Context to reset (login, transaction, or omit for all)",
        required: false,
        enum: ["login", "transaction"]
    })
    @IsOptional()
    @IsEnum(["login", "transaction"])
    context?: "login" | "transaction";
}

/**
 * DTO for Dojah Widget verification result submission
 * Receives verification data from Dojah Widget and saves to database
 */
export class DojahWidgetVerificationDto {
    @ApiProperty({
        description: "Dojah verification ID",
        required: false,
    })
    @IsOptional()
    @IsString()
    verificationId?: string;

    @ApiProperty({
        description: "Dojah reference ID",
        required: false,
    })
    @IsOptional()
    @IsString()
    referenceId?: string;

    @ApiProperty({
        description: "Type of verification performed",
        required: false,
    })
    @IsOptional()
    @IsString()
    verificationType?: string;

    @ApiProperty({
        description: "ID data extracted from document",
        required: false,
    })
    @IsOptional()
    idData?: {
        first_name?: string;
        middle_name?: string;
        last_name?: string;
        full_name?: string;
        date_of_birth?: string;
        document_number?: string;
        expiry_date?: string;
        issue_date?: string;
        nationality?: string;
        gender?: string;
        country?: string;
        document_type?: string;
        photo?: string;
    };

    @ApiProperty({
        description: "Liveness check data",
        required: false,
    })
    @IsOptional()
    liveness?: {
        verified?: boolean;
        confidence?: number;
        photo?: string;
    };

    @ApiProperty({
        description: "Selfie data",
        required: false,
    })
    @IsOptional()
    selfie?: {
        photo?: string;
        verified?: boolean;
    };

    @ApiProperty({
        description: "Face match result",
        required: false,
    })
    @IsOptional()
    faceMatch?: {
        verified?: boolean;
        confidence?: number;
    };

    @ApiProperty({
        description: "Country code (e.g., NG)",
        required: false,
    })
    @IsOptional()
    @IsString()
    country?: string;

    @ApiProperty({
        description: "Document type",
        required: false,
    })
    @IsOptional()
    @IsString()
    documentType?: string;
}

// ==================== Dojah Widget Verification DTOs ====================

export class DojahAddressDataDto {
    @ApiProperty({ description: "Full address string", required: false })
    @IsOptional()
    @IsString()
    fullAddress?: string;

    @ApiProperty({ description: "Street address", required: false })
    @IsOptional()
    @IsString()
    street?: string;

    @ApiProperty({ description: "City", required: false })
    @IsOptional()
    @IsString()
    city?: string;

    @ApiProperty({ description: "State", required: false })
    @IsOptional()
    @IsString()
    state?: string;

    @ApiProperty({ description: "Country", required: false })
    @IsOptional()
    @IsString()
    country?: string;

    @ApiProperty({ description: "Postal code", required: false })
    @IsOptional()
    @IsString()
    postalCode?: string;

    @ApiProperty({ description: "LGA (Local Government Area)", required: false })
    @IsOptional()
    @IsString()
    lga?: string;
}

export class DojahVerifyAddressDto {
    @ApiProperty({ description: "Dojah verification ID or reference ID" })
    @IsNotEmpty()
    @IsString()
    verificationId: string;

    @ApiProperty({ description: "Verification type (e.g., dojah_widget)", default: "dojah_widget" })
    @IsOptional()
    @IsString()
    verificationType?: string;

    @ApiProperty({ description: "Address data from Dojah widget", required: false, type: DojahAddressDataDto })
    @IsOptional()
    address?: DojahAddressDataDto;

    @ApiProperty({ description: "Additional metadata", required: false })
    @IsOptional()
    metadata?: Record<string, unknown>;
}

export class DojahDocumentDataDto {
    @ApiProperty({ description: "Document type (e.g., bank_statement, payslip)", required: false })
    @IsOptional()
    @IsString()
    documentType?: string;

    @ApiProperty({ description: "Document URL if uploaded via Dojah", required: false })
    @IsOptional()
    @IsString()
    documentUrl?: string;

    @ApiProperty({ description: "Document name/title", required: false })
    @IsOptional()
    @IsString()
    documentName?: string;

    @ApiProperty({ description: "Verification status from Dojah", required: false })
    @IsOptional()
    verified?: boolean;
}

export class DojahVerifyIncomeDto {
    @ApiProperty({ description: "Dojah verification ID or reference ID" })
    @IsNotEmpty()
    @IsString()
    verificationId: string;

    @ApiProperty({ description: "Verification type (e.g., dojah_widget)", default: "dojah_widget" })
    @IsOptional()
    @IsString()
    verificationType?: string;

    @ApiProperty({ description: "Document data from Dojah widget", required: false, type: DojahDocumentDataDto })
    @IsOptional()
    document?: DojahDocumentDataDto;

    @ApiProperty({ description: "Additional metadata", required: false })
    @IsOptional()
    metadata?: Record<string, unknown>;
}

// ==================== Dojah Government ID (BVN/NIN) Verification DTOs ====================

export class DojahGovernmentDataDto {
    @ApiProperty({ description: "ID type (bvn, nin, voters_id, etc.)", required: false })
    @IsOptional()
    @IsString()
    idType?: string;

    @ApiProperty({ description: "ID number", required: false })
    @IsOptional()
    @IsString()
    idNumber?: string;

    @ApiProperty({ description: "First name from government database", required: false })
    @IsOptional()
    @IsString()
    firstName?: string;

    @ApiProperty({ description: "Last name from government database", required: false })
    @IsOptional()
    @IsString()
    lastName?: string;

    @ApiProperty({ description: "Middle name from government database", required: false })
    @IsOptional()
    @IsString()
    middleName?: string;

    @ApiProperty({ description: "Date of birth (YYYY-MM-DD)", required: false })
    @IsOptional()
    @IsString()
    dateOfBirth?: string;

    @ApiProperty({ description: "Phone number from government database", required: false })
    @IsOptional()
    @IsString()
    phoneNumber?: string;

    @ApiProperty({ description: "Gender", required: false })
    @IsOptional()
    @IsString()
    gender?: string;

    @ApiProperty({ description: "Whether the ID was verified", required: false })
    @IsOptional()
    verified?: boolean;
}

export class DojahVerifyGovernmentIdDto {
    @ApiProperty({ description: "Dojah verification ID or reference ID" })
    @IsNotEmpty()
    @IsString()
    verificationId: string;

    @ApiProperty({ description: "Verification type (e.g., dojah_widget)", default: "dojah_widget" })
    @IsOptional()
    @IsString()
    verificationType?: string;

    @ApiProperty({ description: "Government ID data from Dojah widget", required: false, type: DojahGovernmentDataDto })
    @IsOptional()
    government?: DojahGovernmentDataDto;

    @ApiProperty({ description: "Additional metadata", required: false })
    @IsOptional()
    metadata?: Record<string, unknown>;
}
