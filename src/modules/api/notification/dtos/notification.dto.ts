import { Transform } from "class-transformer";
import { IsInt, IsOptional, IsString } from "class-validator";
import { PaginationQueryDto } from "../../user/dtos";

export class AdminListNotificationDto extends PaginationQueryDto {
    @IsOptional()
    @IsString()
    searchText?: string;
}

export class NotificationIdParamDto {
    @IsInt()
    @Transform(({ value }) => +value)
    notificationId: number;
}

export class GetNotificationsDto extends PaginationQueryDto {
    @IsOptional()
    @IsString()
    searchText?: string;
}
