import { ApiProperty } from "@nestjs/swagger";
import { Country, DocumentType } from "@prisma/client";
import {
    IsAlphanumeric,
    IsBase64,
    IsEmail,
    IsEnum,
    IsNotEmpty,
    IsNumberString,
    IsOptional,
    IsPhoneNumber,
    IsString,
    Length,
    Matches,
    MaxLength,
    MinLength,
} from "class-validator";

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

// New DTO for sending forgot password email
export class SendForgotPasswordDto {
    @ApiProperty()
    @IsNotEmpty()
    @IsEmail({}, { message: "Invalid email address" })
    email: string;
}

// Extended DTO for reset password
export class ResetPasswordDto extends CreatePasswordDto {
    @ApiProperty()
    @IsNotEmpty()
    @IsEmail({}, { message: "Invalid email address" })
    email: string;

    @ApiProperty()
    @IsNotEmpty()
    @IsString()
    resetCode: string;

    // password field is inherited from CreatePasswordDto
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
    @Length(11, 11, { message: "Bnv number must be 11 digits" })
    bvn: string;
}

export class SignInDto {
    @ApiProperty()
    @IsEmail({}, { message: "Invalid email address" })
    email: string;

    @ApiProperty()
    @IsString({ message: "Invalid password format" })
    password: string;
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
