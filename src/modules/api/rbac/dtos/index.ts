import { ApiProperty, ApiPropertyOptional, PartialType } from "@nestjs/swagger";
import {
    IsString,
    IsNotEmpty,
    IsOptional,
    IsArray,
    IsNumber,
    IsBoolean,
    IsEmail,
    MinLength,
    ArrayMinSize,
} from "class-validator";
import { Transform, Type } from "class-transformer";

// Role DTOs
export class CreateRoleDto {
    @ApiProperty({ description: "Role name", example: "Compliance Officer" })
    @IsString()
    @IsNotEmpty()
    name: string;

    @ApiPropertyOptional({ description: "Role description" })
    @IsString()
    @IsOptional()
    description?: string;

    @ApiProperty({
        description: "Array of permission IDs to assign",
        example: [1, 2, 3],
    })
    @IsArray()
    @IsNumber({}, { each: true })
    @ArrayMinSize(1)
    permissionIds: number[];
}

export class UpdateRoleDto extends PartialType(CreateRoleDto) {}

export class AssignPermissionsDto {
    @ApiProperty({
        description: "Array of permission IDs to assign",
        example: [1, 2, 3],
    })
    @IsArray()
    @IsNumber({}, { each: true })
    permissionIds: number[];
}

// Admin User DTOs
export class CreateAdminUserDto {
    @ApiProperty({ description: "First name", example: "John" })
    @IsString()
    @IsNotEmpty()
    firstName: string;

    @ApiProperty({ description: "Last name", example: "Doe" })
    @IsString()
    @IsNotEmpty()
    lastName: string;

    @ApiProperty({ description: "Email address", example: "admin@flipxer.com" })
    @IsEmail()
    @IsNotEmpty()
    email: string;

    @ApiPropertyOptional({ description: "Phone number" })
    @IsString()
    @IsOptional()
    phone?: string;

    @ApiProperty({ description: "Password", minLength: 8 })
    @IsString()
    @MinLength(8)
    password: string;

    @ApiProperty({ description: "Role ID to assign", example: 1 })
    @IsNumber()
    roleId: number;
}

export class UpdateAdminUserDto {
    @ApiPropertyOptional({ description: "First name" })
    @IsString()
    @IsOptional()
    firstName?: string;

    @ApiPropertyOptional({ description: "Last name" })
    @IsString()
    @IsOptional()
    lastName?: string;

    @ApiPropertyOptional({ description: "Role ID" })
    @IsNumber()
    @IsOptional()
    roleId?: number;

    @ApiPropertyOptional({ description: "Phone number" })
    @IsString()
    @IsOptional()
    phone?: string;

    @ApiPropertyOptional({ description: "Is active" })
    @IsBoolean()
    @IsOptional()
    isActive?: boolean;
}

export class GetAdminUsersDto {
    @ApiPropertyOptional({ description: "Page number", default: 1 })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    pageNumber?: number;

    @ApiPropertyOptional({ description: "Page size", default: 20 })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    pageSize?: number;

    @ApiPropertyOptional({ description: "Search text" })
    @IsOptional()
    @IsString()
    searchText?: string;

    @ApiPropertyOptional({ description: "Filter by role ID" })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    roleId?: number;
}

export class ChangeAdminPasswordDto {
    @ApiProperty({ description: "New password", minLength: 8 })
    @IsString()
    @MinLength(8)
    newPassword: string;
}

// Permission DTOs
export class CreatePermissionDto {
    @ApiProperty({ description: "Permission name", example: "users.create" })
    @IsString()
    @IsNotEmpty()
    name: string;

    @ApiProperty({ description: "Permission description" })
    @IsString()
    @IsNotEmpty()
    description: string;

    @ApiProperty({ description: "Permission group", example: "USERS" })
    @IsString()
    @IsNotEmpty()
    group: string;
}

// Audit Log DTOs
export class GetAuditLogsDto {
    @ApiPropertyOptional({ description: "Page number", default: 1 })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    pageNumber?: number;

    @ApiPropertyOptional({ description: "Page size", default: 20 })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    pageSize?: number;

    @ApiPropertyOptional({ description: "Filter by admin user ID" })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    adminId?: number;

    @ApiPropertyOptional({ description: "Filter by action type" })
    @IsOptional()
    @IsString()
    action?: string;

    @ApiPropertyOptional({ description: "Filter by resource type" })
    @IsOptional()
    @IsString()
    resource?: string;

    @ApiPropertyOptional({ description: "Start date" })
    @IsOptional()
    @IsString()
    startDate?: string;

    @ApiPropertyOptional({ description: "End date" })
    @IsOptional()
    @IsString()
    endDate?: string;
}
