import {
    IsOptional,
    IsString,
    IsEmail,
    IsBooleanString,
    IsEnum,
    IsDateString,
    Matches,
    IsNotEmpty,
} from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";

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

export class UpdateProfileDto {
    @ApiProperty({
        description: "The first name of the user",
        example: "John",
        required: false,
    })
    @IsOptional()
    @IsString()
    firstName: string;

    @ApiProperty({
        description: "The last name of the user",
        example: "Doe",
        required: false,
    })
    @IsOptional()
    @IsString()
    lastName: string;
}

export class RecoveryEmailDto {
    @ApiProperty({ example: "user@example.com" })
    @IsEmail()
    @IsNotEmpty()
    email: string;

    @ApiProperty({ example: "recovery@example.com" })
    @IsEmail()
    @IsNotEmpty()
    recoveryEmail: string;
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
