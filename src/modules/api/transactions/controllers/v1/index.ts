import { SwaggerResponse, ApiResponse } from "@/utils/api-response-util";
import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseIntPipe,
    Post,
    Query,
    UseGuards,
    ValidationPipe,
} from "@nestjs/common";

import { TransactionService } from "../../services";
import {
    ApiTags,
    ApiOperation,
    ApiBearerAuth,
    ApiBody,
    ApiResponse as SwaggerApiResponse,
} from "@nestjs/swagger";
import { AuthGuard, CountryBlockGuard } from "@/modules/api/auth/guard";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { User } from "@/modules/api/user";
import { User as UserModel } from "@prisma/client";
import {
    GeneralReportDownloadDto,
    GetUserTransactionListDto,
} from "../../dtos";
import { CsvHeaders } from "@/utils/decorators";

@ApiTags("transactions")
@UseGuards(CountryBlockGuard, AuthGuard)
@ApiBearerAuth("access-token")
@Controller({
    path: "transactions",
})
export class TransactionController {
    constructor(private transactionService: TransactionService) {}

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "get user transactions" })
    @Get()
    async getUserTransactionHistory(
        @User() user: UserModel,
        @Query() query: GetUserTransactionListDto
    ) {
        return this.transactionService.getUserTransactionHistory(query, user);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "download user general transaction report" })
    @CsvHeaders("general_report.csv")
    @Post("/report/download/general")
    async downloadGeneralReport(
        @User() user: UserModel,
        @Body() dto: GeneralReportDownloadDto
    ) {
        return await this.transactionService.downloadGeneralReport(user, dto);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "user get transaction detail" })
    @Get(":transactionId")
    async getTransactionDetail(@Param("transactionId") transactionId: string) {
        return this.transactionService.getTransactionDetail(transactionId);
    }
}
