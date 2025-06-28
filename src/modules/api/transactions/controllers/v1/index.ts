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
import { AuthGuard } from "@/modules/api/auth/guard";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { User } from "@/modules/api/user";
import { User as UserModel } from "@prisma/client";
import { GetUserTransactionListDto } from "../../dtos";

// @ApiTags("transactions")
// @UseGuards(AuthGuard)
// @ApiBearerAuth("access-token")
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
    @ApiOperation({ summary: "user get transaction detail" })
    @Get(":transactionId")
    async getTransactionDetail(
        @Param("transactionId", ParseIntPipe) transactionId: number
    ) {
        return this.transactionService.getTransactionDetail(transactionId);
    }
}
