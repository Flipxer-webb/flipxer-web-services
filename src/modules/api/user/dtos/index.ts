import {
    IsOptional,
    IsString,
    IsEmail,
    IsBooleanString,
    IsEnum,
    IsDateString,
    Matches,
    IsNotEmpty,
    Length,
    IsInt
} from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { Gender, Country, Status, UserType } from "@prisma/client";

export enum Sort {
    ASC = "asc",
    DSCE = "desc",
}
export class PaginationQueryDto {
    @ApiProperty({
        description:
            "Whether it should be paginated or not : defaults to true - optional",
        example: "true",
        required: false,
    })
    @IsOptional()
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
    sortBy: Sort = Sort.DSCE;
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
    @ApiProperty({ description: "The ID of the user to unflag" })
    @IsNotEmpty()
    @IsInt({ message: "Invalid user ID" })
    id: number;
}