import { ApiProperty } from "@nestjs/swagger";
import { PaginationQueryDto } from "../../user/dtos";
import { IsOptional, IsString } from "class-validator";

export class GetUserTransactionListDto extends PaginationQueryDto {
    @ApiProperty({
        description: "search asset by name",
    })
    @IsOptional()
    @IsString()
    searchText?: string;
}
