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
import {
    AuthGuard,
    CountryBlockGuard,
    EnabledAccountGuard,
} from "@/modules/api/auth/guard";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { User } from "@/modules/api/user";
import { User as UserModel, UserType } from "@prisma/client";
import { GetUserTransactionListDto } from "../../dtos";
import { UserTypes } from "@/modules/api/authorize/decorator";

@ApiTags("admin")
@UseGuards(CountryBlockGuard, AuthGuard, RoleGuard, EnabledAccountGuard)
@UserTypes([UserType.ADMIN])
@ApiBearerAuth("access-token")
@Controller({
    path: "admin/transactions",
})
export class AdminTransactionController {
    constructor(private transactionService: TransactionService) {}

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "admin gets all transactions" })
    @Get()
    async getAllTransactionList(@Query() query: GetUserTransactionListDto) {
        return this.transactionService.getUserTransactionHistory(query);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "admin gets recent transactions" })
    @Get("recent")
    async getRecentTransactionList() {
        return this.transactionService.getRecentTransactionList();
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "admin get transaction detail" })
    @Get(":transactionId")
    async getTransactionDetail(@Param("transactionId") transactionId: string) {
        return this.transactionService.getTransactionDetail(transactionId);
    }
}
