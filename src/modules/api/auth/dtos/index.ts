import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Country, DocumentType } from "@prisma/client";
import {
    IsAlphanumeric,
    IsEmail,
    IsEnum,
    IsNotEmpty,
    IsNumber,
    IsNumberString,
    IsOptional,
    IsPhoneNumber,
    IsString,
    IsArray,
    IsDateString,
    ValidateNested,
    Min,
    Max,
    Length,
    Matches,
    MaxLength,
    MinLength,
} from "class-validator";
import { Type } from "class-transformer";

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
    @Matches(/^(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9])\S+$/, {
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

export class ValidateAdminInviteDto {
    @ApiProperty()
    @IsNotEmpty()
    @IsString()
    token: string;
}

export class AcceptAdminInviteDto {
    @ApiProperty()
    @IsNotEmpty()
    @IsString()
    token: string;

    @ApiProperty()
    @IsNotEmpty()
    @IsString()
    phone: string;

    @ApiProperty({
        description:
            "Password (min 12 chars, must include uppercase, lowercase, number, and special character)",
        minLength: 12,
    })
    @IsNotEmpty()
    @IsString()
    @MinLength(12)
    @Matches(
        /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~])/,
        {
            message:
                "Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character",
        },
    )
    password: string;
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

    @ApiProperty({
        required: false,
        description: "Device name for session tracking",
    })
    @IsString()
    @IsOptional()
    deviceName?: string;

    @ApiProperty({
        required: false,
        description: "Device type (mobile, desktop, tablet)",
    })
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
        description: "Residential address for address verification matching",
        required: false,
    })
    @IsOptional()
    @IsString()
    residentialAddress?: string;

    @ApiProperty({
        description: "Optional business name for business accounts",
        required: false,
    })
    @IsOptional()
    @IsString()
    businessName?: string;

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
    @Matches(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, {
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
    @Matches(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, {
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
    @Matches(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, {
        message:
            "Date of Birth must be in YYYY-MM-DD format (e.g., 2024-06-01)",
    })
    dateOfBirth: string;

    @ApiProperty({
        description:
            "Residential address used for address-verification matching",
        example: "10 Main Street, Ikeja, Lagos",
    })
    @IsNotEmpty()
    @IsString()
    residentialAddress: string;
}

export class SignInDto {
    @ApiProperty()
    @IsEmail({}, { message: "Invalid email address" })
    email: string;

    @ApiProperty()
    @IsString({ message: "Invalid password format" })
    password: string;

    @ApiProperty({
        required: false,
        description: "Device name for session tracking",
    })
    @IsString()
    @IsOptional()
    deviceName?: string;

    @ApiProperty({
        required: false,
        description: "Device type (mobile, desktop, tablet)",
    })
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

    @ApiPropertyOptional({
        description: "Document number (e.g., passport number, license number)",
    })
    @IsOptional()
    @IsString()
    documentNumber?: string;

    @ApiProperty({
        description:
            "Base64-encoded front image of the document (without data:image prefix)",
    })
    @IsNotEmpty()
    @IsString()
    imageFrontBase64: string;

    @ApiProperty({
        required: false,
        description:
            "Base64-encoded back image of the document (without data:image prefix)",
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
        enum: DocumentType,
        enumName: "DocumentType",
        description:
            "Selected document type/path to validate the uploaded document against",
    })
    @IsNotEmpty()
    @IsEnum(DocumentType)
    documentType: DocumentType;

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
            "Field name identifying the uploaded document. Supported values include cacImage, applicationForRegistration, memart, companyUtilityBills, companyAmlPolicy, scumlCertificate, companyOrganogram, companyLicense, flowsBusinessFunds, articleOfAssociationImage, boardResolutionAuthorizedAcctOpeningImage, directors[n].idDocument, directors[n].proofOfAddress, shareholders[n].idDocument, shareholders[n].proofOfAddress. Legacy beneficial-owner fields proofOfAddressForBeneficialOwner and meansOfIdentificationForBeneficialOwner remain supported.",
    })
    @IsNotEmpty()
    @IsString()
    fieldName: string;
}

export class UploadBusinessDocumentFileFormDto {
    @ApiProperty({
        type: "string",
        description: "Supported business document field name",
    })
    fieldName: string;

    @ApiProperty({
        type: "string",
        format: "binary",
        description: "The document file",
    })
    file: any;
}

export class BusinessDirectorDto {
    @ApiProperty({ description: "Director full name" })
    @IsNotEmpty()
    @IsString()
    fullName: string;

    @ApiProperty({ description: "Nationality" })
    @IsNotEmpty()
    @IsString()
    nationality: string;

    @ApiProperty({ description: "Date of birth (YYYY-MM-DD)" })
    @IsNotEmpty()
    @IsDateString()
    dateOfBirth: string;

    @ApiProperty({ description: "Residential address" })
    @IsNotEmpty()
    @IsString()
    residentialAddress: string;

    @ApiProperty({ description: "Business address" })
    @IsNotEmpty()
    @IsString()
    businessAddress: string;

    @ApiPropertyOptional({
        description: "National Identification Number (NIN)",
        required: false,
    })
    @IsOptional()
    @IsString()
    nin?: string;
}

export class BusinessShareholderDto {
    @ApiProperty({ description: "Shareholder full name" })
    @IsNotEmpty()
    @IsString()
    fullName: string;

    @ApiProperty({ description: "Nationality" })
    @IsNotEmpty()
    @IsString()
    nationality: string;

    @ApiProperty({ description: "Date of birth (YYYY-MM-DD)" })
    @IsNotEmpty()
    @IsDateString()
    dateOfBirth: string;

    @ApiProperty({ description: "Residential address" })
    @IsNotEmpty()
    @IsString()
    residentialAddress: string;

    @ApiProperty({ description: "Business address" })
    @IsNotEmpty()
    @IsString()
    businessAddress: string;

    @ApiPropertyOptional({
        description: "National Identification Number (NIN)",
        required: false,
    })
    @IsOptional()
    @IsString()
    nin?: string;

    @ApiProperty({ description: "Ownership percentage (>5)" })
    @IsNotEmpty()
    @IsNumber()
    @Type(() => Number)
    @Min(5)
    @Max(100)
    ownershipPercentage: number;
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

    @ApiPropertyOptional({
        description: "Company website URL",
        required: false,
    })
    @IsOptional()
    @IsString()
    companyWebsite?: string;

    @ApiPropertyOptional({
        description: "Company tax ID (TIN) as text value",
        required: false,
    })
    @IsOptional()
    @IsString()
    companyTaxId?: string;

    @ApiPropertyOptional({
        description: "Company registered address",
        required: false,
    })
    @IsOptional()
    @IsString()
    companyAddress?: string;

    @ApiPropertyOptional({
        description: "Nature of business (one of the supported categories)",
        required: false,
    })
    @IsOptional()
    @IsString()
    natureOfBusiness?: string;

    @ApiPropertyOptional({
        description: "Purpose of transaction / end use",
        required: false,
    })
    @IsOptional()
    @IsString()
    purposeOfTransaction?: string;

    @ApiPropertyOptional({
        description: "If purposeOfTransaction is 'Other', specify here",
        required: false,
    })
    @IsOptional()
    @IsString()
    purposeOfTransactionOther?: string;

    @ApiPropertyOptional({
        description: "Directors list (with per-director KYC details)",
        required: false,
        type: () => [BusinessDirectorDto],
    })
    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => BusinessDirectorDto)
    directors?: BusinessDirectorDto[];

    @ApiPropertyOptional({
        description:
            "Shareholders (>5%) list (with per-shareholder KYC details)",
        required: false,
        type: () => [BusinessShareholderDto],
    })
    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => BusinessShareholderDto)
    shareholders?: BusinessShareholderDto[];

    @ApiProperty({
        description: "Map of fieldName → ImageKit URL for each uploaded file",
    })
    @IsNotEmpty()
    uploadedFiles: Record<
        string,
        { url: string; fileId: string; originalName?: string }
    >;
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
    @ApiProperty({
        type: "string",
        format: "binary",
        description: "Address proof document (utility bill, bank statement)",
    })
    document: Express.Multer.File;
}

export class VerifyIncomeUploadFormDto {
    @ApiProperty({
        type: "string",
        format: "binary",
        description:
            "Income proof document (payslip, bank statement, tax document)",
    })
    document: Express.Multer.File;
}

export class IndividualKycStageFileUploadFormDto {
    @ApiPropertyOptional({
        description:
            "Optional stage method override for the new stage-based KYC routes",
        required: false,
    })
    @IsOptional()
    @IsString()
    method?: string;

    @ApiProperty({
        type: "string",
        format: "binary",
        description: "KYC evidence file",
    })
    document: Express.Multer.File;
}

export class CreateTradingPasswordDto {
    @ApiProperty({ description: "Trading password (6+ characters)" })
    @IsNotEmpty()
    @IsString()
    @MinLength(6, { message: "Trading password must be at least 6 characters" })
    @MaxLength(50, {
        message: "Trading password must not exceed 50 characters",
    })
    tradingPassword: string;

    @ApiProperty({ description: "Confirm trading password" })
    @IsNotEmpty()
    @IsString()
    confirmTradingPassword: string;
}

export class Reset2FARateLimitDto {
    @ApiProperty({
        example: 123,
        description: "User ID to reset rate limit for",
    })
    @IsNotEmpty()
    @IsNumber()
    userId: number;

    @ApiProperty({
        example: "login",
        description: "Context to reset (login, transaction, or omit for all)",
        required: false,
        enum: ["login", "transaction"],
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
