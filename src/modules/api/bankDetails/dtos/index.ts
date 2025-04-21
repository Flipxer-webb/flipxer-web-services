import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
    IsNotEmpty,
    IsString,
    Matches,
    IsOptional,
    IsNumber,
} from "class-validator";
import { Type } from "class-transformer";

export class CreateBankDetailDto {
    @ApiProperty({
        description: "Name of the bank (e.g., First Bank, GTBank)",
        example: "First Bank",
    })
    @IsNotEmpty({ message: "Bank name is required" })
    @IsString({ message: "Bank name must be a string" })
    bankName: string;

    @ApiProperty({
        description: "Name of the account holder",
        example: "John Doe",
    })
    @IsNotEmpty({ message: "Account name is required" })
    @IsString({ message: "Account name must be a string" })
    accountName: string;

    @ApiProperty({
        description: "Bank account number (10 digits for Nigerian banks)",
        example: "1234567890",
    })
    @IsNotEmpty({ message: "Account number is required" })
    @IsString({ message: "Account number must be a string" })
    @Matches(/^\d{10}$/, {
        message: "Account number must be exactly 10 digits",
    })
    accountNumber: string;
}

export class UpdateBankDetailDto {
    @ApiPropertyOptional({
        description: "Name of the bank (e.g., First Bank, GTBank)",
        example: "First Bank",
    })
    @IsOptional()
    @IsString({ message: "Bank name must be a string" })
    bankName?: string;

    @ApiPropertyOptional({
        description: "Name of the account holder",
        example: "John Doe",
    })
    @IsOptional()
    @IsString({ message: "Account name must be a string" })
    accountName?: string;

    @ApiPropertyOptional({
        description: "Bank account number (10 digits for Nigerian banks)",
        example: "1234567890",
    })
    @IsOptional()
    @IsString({ message: "Account number must be a string" })
    @Matches(/^\d{10}$/, {
        message: "Account number must be exactly 10 digits",
    })
    accountNumber?: string;
}

export class BankDetailResponseDto {
    @ApiProperty({
        description: "Unique identifier of the bank detail",
        example: 1,
    })
    @IsNumber()
    @Type(() => Number)
    id: number;

    @ApiProperty({
        description: "ID of the user this bank detail belongs to",
        example: 1,
    })
    @IsNumber()
    @Type(() => Number)
    userId: number;

    @ApiProperty({ description: "Name of the bank", example: "First Bank" })
    @IsString()
    bankName: string;

    @ApiProperty({
        description: "Name of the account holder",
        example: "John Doe",
    })
    @IsString()
    accountName: string;

    @ApiProperty({ description: "Bank account number", example: "1234567890" })
    @IsString()
    accountNumber: string;

    @ApiProperty({
        description: "Creation date of the bank detail",
        example: "2023-01-01T00:00:00Z",
    })
    @Type(() => Date)
    createdAt: Date;

    @ApiProperty({
        description: "Last updated date of the bank detail",
        example: "2023-01-01T00:00:00Z",
    })
    @Type(() => Date)
    updatedAt: Date;
}
