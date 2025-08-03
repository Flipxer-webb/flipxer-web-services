import { Transform } from "class-transformer";
import { IsInt, IsOptional, IsString } from "class-validator";
import { PaginationQueryDto } from "../../user/dtos";
import { ApiProperty } from "@nestjs/swagger";

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
