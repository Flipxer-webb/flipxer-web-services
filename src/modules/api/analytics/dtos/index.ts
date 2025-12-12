import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, IsNumber, IsIn } from "class-validator";
import { Type } from "class-transformer";

export class GetAnalyticsDto {
    @ApiPropertyOptional({ 
        description: "Time period filter", 
        enum: ["today", "week", "month", "quarter", "year", "all"],
        default: "month" 
    })
    @IsOptional()
    @IsString()
    @IsIn(["today", "week", "month", "quarter", "year", "all"])
    period?: string;

    @ApiPropertyOptional({ description: "Start date (ISO format)" })
    @IsOptional()
    @IsString()
    startDate?: string;

    @ApiPropertyOptional({ description: "End date (ISO format)" })
    @IsOptional()
    @IsString()
    endDate?: string;
}

export class GetChartDataDto extends GetAnalyticsDto {
    @ApiPropertyOptional({ 
        description: "Chart granularity", 
        enum: ["hourly", "daily", "weekly", "monthly"],
        default: "daily"
    })
    @IsOptional()
    @IsString()
    @IsIn(["hourly", "daily", "weekly", "monthly"])
    granularity?: string;

    @ApiPropertyOptional({ 
        description: "Transaction category filter",
        enum: ["BUY", "SELL", "SWAP", "SEND", "RECEIVE", "all"]
    })
    @IsOptional()
    @IsString()
    category?: string;
}

export class GetUserGrowthDto extends GetAnalyticsDto {
    @ApiPropertyOptional({ 
        description: "User type filter", 
        enum: ["INDIVIDUAL", "BUSINESS", "all"] 
    })
    @IsOptional()
    @IsString()
    userType?: string;
}

export class GetRevenueAnalyticsDto extends GetAnalyticsDto {
    @ApiPropertyOptional({ 
        description: "Revenue source filter",
        enum: ["fees", "spread", "all"]
    })
    @IsOptional()
    @IsString()
    source?: string;

    @ApiPropertyOptional({ description: "Currency filter" })
    @IsOptional()
    @IsString()
    currency?: string;
}

export class GetAssetDistributionDto {
    @ApiPropertyOptional({ description: "Limit number of assets to return" })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    limit?: number;
}
