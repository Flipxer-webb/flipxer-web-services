import { ApiProperty } from "@nestjs/swagger";
import { TransactionFeeCategory } from "@prisma/client";
import {
    IsEnum,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsString,
    IsBoolean,
    Matches,
    Min,
} from "class-validator";

export class CreateOrUpdateCryptoRateDto {
    @ApiProperty({ description: "crypto currency name" })
    @IsNotEmpty()
    @IsString()
    currency: string;

    @ApiProperty({ description: "crypto buyRate", required: false })
    @IsOptional()
    @IsNumber()
    @Min(0)
    buyRate?: number;

    @ApiProperty({ description: "crypto sellRate", required: false })
    @IsOptional()
    @IsNumber()
    @Min(0)
    sellRate?: number;
}

export class CreateOrUpdateCryptoTransactionFeeDto {
    @ApiProperty({ description: "crypto transaction fee category" })
    @IsNotEmpty()
    @IsEnum(TransactionFeeCategory)
    category: TransactionFeeCategory;

    @ApiProperty({ description: "crypto currency name" })
    @IsNotEmpty()
    @IsString()
    currency: string;

    @ApiProperty({ description: "crypto transaction fee", required: false })
    @IsOptional()
    @IsNumber()
    @Min(0)
    fee?: number;
}

export class GetCryptoTransactionFeePerAssetDto {
    @ApiProperty({
        description: "crypto transaction fee category",
        enum: TransactionFeeCategory,
    })
    @IsNotEmpty()
    @IsEnum(TransactionFeeCategory)
    category: TransactionFeeCategory;
}

export class AddAllowedIpDto {
    @ApiProperty({
        description: "Public IP address to allow (IPv4 or IPv6)",
        example: "203.0.113.10",
    })
    @IsNotEmpty({ message: "IP address is required" })
    @IsString({ message: "IP address must be a string" })
    @Matches(/^(?!0)(?!.*\.$)((25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.|$)){4}$/, {
        message: "Invalid IPv4 format",
    })
    ip: string;

    @ApiProperty({
        required: false,
        description: "Optional label for the IP address",
        example: "Home Wi-Fi",
    })
    @IsOptional()
    @IsString({ message: "Label must be a string" })
    label?: string;
}

export class UpdateAllowedIpDto {
    @ApiProperty({
        required: false,
        description: "New label for the allowed IP",
        example: "Office Network",
    })
    @IsOptional()
    @IsString()
    label?: string;

    @ApiProperty({
        required: false,
        description: "Activate or deactivate this IP",
        example: true,
    })
    @IsOptional()
    isActive?: boolean;
}

// 2FA DTOs
export class Enable2FADto {
    @ApiProperty({
        description: "6-digit TOTP code from authenticator app",
        example: "123456",
    })
    @IsNotEmpty({ message: "TOTP code is required" })
    @IsString()
    @Matches(/^\d{6}$/, { message: "TOTP code must be 6 digits" })
    code: string;
}

export class Disable2FADto {
    @ApiProperty({
        description: "6-digit TOTP code from authenticator app",
        example: "123456",
    })
    @IsNotEmpty({ message: "TOTP code is required" })
    @IsString()
    @Matches(/^\d{6}$/, { message: "TOTP code must be 6 digits" })
    code: string;

    @ApiProperty({
        description: "User password for verification",
    })
    @IsNotEmpty({ message: "Password is required" })
    @IsString()
    password: string;
}

export class Verify2FACodeDto {
    @ApiProperty({
        description: "6-digit TOTP code from authenticator app",
        example: "123456",
    })
    @IsNotEmpty({ message: "TOTP code is required" })
    @IsString()
    @Matches(/^\d{6}$/, { message: "TOTP code must be 6 digits" })
    code: string;
}

// ==================== Security Preferences DTOs ====================

export class SecurityMethodsDto {
    @ApiProperty({ description: "Enable SMS verification for transactions", example: true })
    @IsOptional()
    sms?: boolean;

    @ApiProperty({ description: "Enable Email verification for transactions", example: true })
    @IsOptional()
    email?: boolean;

    @ApiProperty({ description: "Enable Authenticator app for transactions", example: false })
    @IsOptional()
    authenticator?: boolean;

    @ApiProperty({ description: "Enable Trading Password for transactions", example: false })
    @IsOptional()
    @IsBoolean()
    tradingPassword?: boolean;

    @ApiProperty({ description: "Enable Biometric verification for transactions", example: false })
    @IsOptional()
    @IsBoolean()
    biometric?: boolean;
}

export class UpdateSecurityPreferencesDto {
    @ApiProperty({ description: "Security methods configuration", type: SecurityMethodsDto })
    @IsOptional()
    methods?: SecurityMethodsDto;

    @ApiProperty({ description: "Number of methods required per transaction (1 or 2)", example: 1 })
    @IsOptional()
    @IsNumber()
    @Min(1)
    requiredMethodCount?: number;
}

export class SetTradingPasswordDto {
    @ApiProperty({ description: "New trading password" })
    @IsNotEmpty({ message: "Trading password is required" })
    @IsString()
    @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/, {
        message: "Trading password must be at least 8 characters with uppercase, lowercase, and number",
    })
    tradingPassword: string;

    @ApiProperty({ description: "Current account password for verification" })
    @IsNotEmpty({ message: "Account password is required" })
    @IsString()
    accountPassword: string;
}

export class VerifySecurityMethodDto {
    @ApiProperty({
        description: "Security method to verify",
        enum: ["sms", "email", "authenticator", "tradingPassword", "backupCode"],
        example: "sms"
    })
    @IsNotEmpty()
    @IsString()
    method: "sms" | "email" | "authenticator" | "tradingPassword" | "backupCode";

    @ApiProperty({ description: "Verification code or password", example: "123456" })
    @IsNotEmpty()
    @IsString()
    code: string;

    @ApiProperty({
        description: "SHA256 hash of transaction context (amount|currency|recipient). Required for transaction verification.",
        example: "a1b2c3d4e5f6...",
        required: false,
    })
    @IsOptional()
    @IsString()
    @Matches(/^[a-f0-9]{64}$/i, { message: "contextHash must be a valid SHA256 hash (64 hex characters)" })
    contextHash?: string;
}

export class SendTransactionOtpDto {
    @ApiProperty({
        description: "Method to send OTP",
        enum: ["sms", "email"],
        example: "sms"
    })
    @IsNotEmpty()
    @IsString()
    method: "sms" | "email";
}

export class VerifyMethodForDisableDto {
    @ApiProperty({
        description: "Method to verify before disabling another",
        enum: ["sms", "email", "authenticator", "tradingPassword"],
        example: "authenticator"
    })
    @IsNotEmpty()
    @IsString()
    method: "sms" | "email" | "authenticator" | "tradingPassword";

    @ApiProperty({ description: "Verification code for the method", example: "123456" })
    @IsNotEmpty()
    @IsString()
    code: string;

    @ApiProperty({ description: "Method to disable after verification", example: "sms" })
    @IsNotEmpty()
    @IsString()
    methodToDisable: "sms" | "email" | "authenticator" | "tradingPassword";
}
