import {
    IsOptional,
    IsString,
    IsEmail,
    Length,
    IsNotEmpty,
    IsBooleanString,
    IsEnum,
} from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";

export enum Sort {
    ASC = "asc",
    DSCE = "desc",
}
export class PaginationQueryDto {
    @ApiProperty({
        description: "Whether it should be paginated or not : defaults to true",
        example: "'true' or 'false'",
        required: false,
    })
    @IsOptional()
    @IsBooleanString()
    paginated?: string = "true";

    @ApiProperty({
        description: "Page number desired : defaults to 1",
        example: "1",
        required: false,
    })
    @IsOptional()
    @Transform(({ value }) => +value)
    pageNumber?: number;

    @ApiProperty({
        description: "Document size per page : default to 10",
        example: "10",
        required: false,
    })
    @IsOptional()
    @Transform(({ value }) => +value)
    pageSize?: number;

    @ApiProperty({
        description: "Sort enum (asc or desc) : default to desc",
        example: "10",
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


export class recoveryEmailDto {
    @ApiProperty({
        description: "The registered email address of the user",
        example: "user@example.com",
    })
    @IsEmail()
    email: string;

    @ApiProperty({
        description: "The recovery email address to be updated for the user",
        example: "recovery@example.com",
    })
    @IsEmail()
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
