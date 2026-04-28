import {
    IsOptional,
    IsString,
    IsEmail,
    IsBooleanString,
    IsEnum,
    IsDateString,
    Matches,
    IsNotEmpty,
    IsNumber,
} from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { Gender, Country, Status, UserType } from "@prisma/client";

export enum Sort {
    ASC = "asc",
    DESC = "desc",
}
export class PaginationQueryDto {
    @ApiProperty({
        description:
            "Whether it should be paginated or not : defaults to true - optional",
        example: "true",
        required: false,
    })
    @IsOptional()
    @Transform(({ value }) => value)
    @IsBooleanString()
    paginated?: string = "true";

    @ApiProperty({
        description: "Page number desired : defaults to 1 - optional",
        example: "1",
        required: false,
    })
    @IsOptional()
    @Transform(({ value }) => +value)
    pageNumber?: number;

    @ApiProperty({
        description: "Document size per page : default to 10 - optional",
        example: "10",
        required: false,
    })
    @IsOptional()
    @Transform(({ value }) => +value)
    pageSize?: number;

    @ApiProperty({
        description: "Sort enum (asc or desc) : default to desc - optional",
        example: "desc",
        required: false,
    })
    @IsEnum(Sort)
    sortBy?: Sort = Sort.DESC;
}

export class UpdateUserDetailsDto {
    @IsString()
    @IsOptional()
    firstName?: string;

    @IsString()
    @IsOptional()
    lastName?: string;

    @IsString()
    @IsOptional()
    phone?: string;

    @IsEnum(Gender)
    @IsOptional()
    gender?: Gender;

    @IsDateString()
    @IsOptional()
    dateOfBirth?: string;

    @IsEnum(Country)
    @IsOptional()
    country?: Country;
}

export class SendRecoveryEmailOtpDto {
    @ApiProperty({
        description: "The recovery email address to send the OTP to",
        example: "recovery@example.com",
    })
    @IsEmail()
    email: string;
}

export class VerifyRecoveryEmailOtpDto {
    @ApiProperty({
        description: "The OTP sent to the user's primary email",
        example: "123456",
    })
    @IsString()
    @IsNotEmpty()
    otp: string;
}

export class GetUserAssetsDto extends PaginationQueryDto {
    @ApiProperty({
        description: "search asset by name",
        required: false,
    })
    @IsOptional()
    @IsString()
    searchText?: string;

    @ApiProperty({
        description: "Include all supported trade assets (even those without wallets)",
        required: false,
    })
    @IsOptional()
    @IsBooleanString()
    includeSupported?: string;
}

export class GetUserListDto extends PaginationQueryDto {
    @ApiProperty({
        description: "filter users by status",
        required: false,
        enum: Status,
        example: Status.ACTIVE,
    })
    @IsOptional()
    @IsEnum(Status)
    status?: Status;

    @ApiProperty({
        description: "filter users by user group",
        required: false,
        enum: UserType,
        example: UserType.BUSINESS,
    })
    @IsOptional()
    @IsEnum(UserType)
    accountType?: UserType;

    @ApiProperty({
        description: "filter by start date",
        required: false,
    })
    @IsOptional()
    @IsDateString()
    startDate?: string;

    @ApiProperty({
        description: "filter by end date",
        required: false,
    })
    @IsOptional()
    @IsDateString()
    endDate?: string;

    @ApiProperty({
        description: "search user by name, phone or email",
        required: false,
    })
    @IsOptional()
    @IsString()
    searchText?: string;

    @ApiProperty({
        description: "filter users by tier level (0-3)",
        required: false,
    })
    @IsOptional()
    @IsString()
    tier?: string;

    @ApiProperty({
        description: "filter/sort users by balance: has_balance, zero_balance, highest_first, lowest_first",
        required: false,
    })
    @IsOptional()
    @IsString()
    balanceFilter?: string;
}
export class UpdateProfilePasswordDto {
    @ApiProperty({
        description: "your current password",
        example: "current password",
    })
    @IsString()
    oldPassword: string;

    @ApiProperty({
        description: "Your new desired password",
        example: "NewPassw0rd!",
    })
    @IsString()
    @Matches(/^(?=.*[A-Z])(?=.*\d)(?=.*[!@#$&%])[A-Za-z\d!@#$&%]{10,100}$/, {
        message:
            "Password must be 10-100 characters long, contain at least one uppercase letter, one number, and one special character (!@#$&%)",
    })
    newPassword: string;
}

export class UnflagUserDto {
    @ApiProperty({
        description: "The ID of the user to unflag",
    })
    @IsNotEmpty()
    @IsNumber({}, { message: "User ID must be a number" })
    id: number;
}

// dtos.ts
export class FlagUserDto {
    @ApiProperty({
        description: "The ID of the user to flag",
    })
    @IsNotEmpty()
    @IsNumber({}, { message: "User ID must be a number" })
    id: number;

    @ApiProperty({
        description: "The reason for flagging the user",
    })
    @IsNotEmpty()
    @IsString()
    reason: string;
}

export class SetLimitOverrideDto {
    @ApiProperty({ description: "The ID of the user to override limits for" })
    @IsNotEmpty()
    @IsNumber({}, { message: "User ID must be a number" })
    userId: number;

    @ApiProperty({ description: "Daily limit override in USD (null to use tier default)", required: false })
    @IsOptional()
    @IsNumber({}, { message: "Daily limit must be a number" })
    dailyLimitUSD?: number;

    @ApiProperty({ description: "Reason for the override" })
    @IsNotEmpty()
    @IsString()
    reason: string;

    @ApiProperty({ description: "Override expiration date (ISO 8601). Omit for permanent.", required: false })
    @IsOptional()
    @IsDateString()
    expiresAt?: string;
}

export class RemoveLimitOverrideDto {
    @ApiProperty({ description: "The ID of the user to remove the override for" })
    @IsNotEmpty()
    @IsNumber({}, { message: "User ID must be a number" })
    userId: number;
}
