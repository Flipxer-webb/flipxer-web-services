import { ApiProperty } from "@nestjs/swagger";
import { PaginationQueryDto } from "../../user/dtos";
import {
    IsDateString,
    IsEnum,
    IsNumberString,
    IsOptional,
    IsString,
} from "class-validator";
import { OrderCategory } from "@prisma/client";

export class GetUserTransactionListDto extends PaginationQueryDto {
    @ApiProperty({
        description: "filter by transaction type",
        required: false,
    })
    @IsOptional()
    @IsEnum(OrderCategory)
    type?: OrderCategory;

    @ApiProperty({
        description: "filter by asset name or asset symbol",
        required: false,
    })
    @IsOptional()
    @IsString()
    asset?: string;

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
        description: "search transaction using transaction id",
        required: false,
    })
    @IsOptional()
    @IsNumberString()
    searchText?: string;
}
