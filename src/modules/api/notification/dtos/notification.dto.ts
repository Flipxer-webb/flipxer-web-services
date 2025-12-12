import { Transform } from "class-transformer";
import { IsInt, IsOptional, IsString, IsArray, IsIn, IsNumber, IsEnum } from "class-validator";
import { PaginationQueryDto } from "../../user/dtos";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { NotificationStatus } from "@prisma/client";

export class AdminListNotificationDto extends PaginationQueryDto {
    @ApiProperty({ required: false })
    @IsOptional()
    @IsString()
    searchText?: string;
}

export class NotificationIdParamDto {
    @ApiProperty({ example: 1 })
    @IsInt()
    @Transform(({ value }) => +value)
    notificationId: number;
}

export class GetNotificationsDto extends PaginationQueryDto {
    @ApiProperty({ required: false })
    @IsOptional()
    @IsString()
    searchText?: string;
}

// ==================== NEW ADMIN NOTIFICATION DTOs ====================

export class CreateNotificationDto {
    @ApiProperty({ description: "Notification title" })
    @IsString()
    title: string;

    @ApiPropertyOptional({ description: "Notification body" })
    @IsOptional()
    @IsString()
    body?: string;

    @ApiProperty({ 
        description: "Notification type",
        enum: ["PUSH_NOTIFICATION", "MESSAGE"],
        default: "MESSAGE"
    })
    @IsString()
    @IsIn(["PUSH_NOTIFICATION", "MESSAGE"])
    type: string;

    @ApiProperty({ 
        description: "Beneficiary type",
        enum: ["ALL", "INDIVIDUAL"]
    })
    @IsString()
    @IsIn(["ALL", "INDIVIDUAL"])
    beneficiary: string;

    @ApiPropertyOptional({ description: "User ID (for individual notifications)" })
    @IsOptional()
    @IsNumber()
    userId?: number;
}

export class BroadcastNotificationDto {
    @ApiProperty({ description: "Notification title" })
    @IsString()
    title: string;

    @ApiProperty({ description: "Notification body" })
    @IsString()
    body: string;

    @ApiPropertyOptional({ 
        description: "Notification type",
        enum: ["PUSH_NOTIFICATION", "MESSAGE"],
        default: "PUSH_NOTIFICATION"
    })
    @IsOptional()
    @IsString()
    type?: string;

    @ApiProperty({ 
        description: "Target audience",
        enum: ["all", "individual", "business", "verified"]
    })
    @IsString()
    @IsIn(["all", "individual", "business", "verified"])
    targetAudience: string;

    @ApiPropertyOptional({ 
        description: "User IDs (for individual targeting)",
        type: [Number]
    })
    @IsOptional()
    @IsArray()
    userIds?: number[];
}

export class UpdateNotificationStatusDto {
    @ApiProperty({ 
        description: "New status",
        enum: NotificationStatus
    })
    @IsEnum(NotificationStatus)
    status: NotificationStatus;
}

