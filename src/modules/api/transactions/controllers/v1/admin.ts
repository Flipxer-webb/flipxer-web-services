import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseIntPipe,
    Post,
    Put,
    Query,
    UseGuards,
    Req,
} from "@nestjs/common";

import { TransactionService } from "../../services";
import { AdminTransactionService } from "../../services/admin-transaction.service";
import { TradingService } from "@/modules/api/trade/services";
import {
    ApiTags,
    ApiOperation,
    ApiBearerAuth,
} from "@nestjs/swagger";
import {
    AuthGuard,
    CountryBlockGuard,
    EnabledAccountGuard,
} from "@/modules/api/auth/guard";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { PermissionGuard } from "@/modules/api/authorize/guards/permission.guard";
import { User } from "@/modules/api/user";
import { User as UserModel } from "@prisma/client";
import {
    GetUserTransactionListDto,
    UpdateTransactionStatusDto,
    ManualApproveTransactionDto,
    RefundTransactionDto,
    BulkTransactionActionDto,
} from "../../dtos";
import { UserTypes, Permissions, ADMIN_USER_TYPES } from "@/modules/api/authorize/decorator";
import { PermissionName } from "@/modules/api/authorize/enums/role";

@ApiTags("admin")
@UseGuards(CountryBlockGuard, AuthGuard, RoleGuard, EnabledAccountGuard, PermissionGuard)
@UserTypes(ADMIN_USER_TYPES)
@ApiBearerAuth("access-token")
@Controller({
    path: "admin/transactions",
})
export class AdminTransactionController {
    constructor(
        private readonly transactionService: TransactionService,
        private readonly adminTransactionService: AdminTransactionService,
        private readonly tradingService: TradingService,
    ) { }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "admin gets all transactions" })
    @Permissions([PermissionName.TRANSACTIONS_READ])
    @Get()
    async getAllTransactionList(@Query() query: GetUserTransactionListDto) {
        return this.transactionService.getUserTransactionHistory(query);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "admin gets recent transactions" })
    @Permissions([PermissionName.TRANSACTIONS_READ])
    @Get("recent")
    async getRecentTransactionList() {
        return this.transactionService.getRecentTransactionList();
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Get pending transactions requiring attention" })
    @Permissions([PermissionName.TRANSACTIONS_READ])
    @Get("pending")
    async getPendingTransactions(@Query() query: GetUserTransactionListDto) {
        return this.adminTransactionService.getPendingTransactions(query);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Get failed transactions for review" })
    @Permissions([PermissionName.TRANSACTIONS_READ])
    @Get("failed")
    async getFailedTransactions(@Query() query: GetUserTransactionListDto) {
        return this.adminTransactionService.getFailedTransactions(query);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Get transaction statistics" })
    @Permissions([PermissionName.TRANSACTIONS_READ])
    @Get("stats")
    async getTransactionStats(
        @Query("period") period?: string,
        @Query("status") status?: string,
        @Query("type") type?: string,
        @Query("startDate") startDate?: string,
        @Query("endDate") endDate?: string,
        @Query("source") source?: string,
    ) {
        return this.adminTransactionService.getTransactionStats(period, status, type, startDate, endDate, source);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "admin get transaction detail" })
    @Permissions([PermissionName.TRANSACTIONS_READ])
    @Get(":transactionId")
    async getTransactionDetail(@Param("transactionId") transactionId: string) {
        return this.transactionService.getTransactionDetail(transactionId);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Get transaction audit logs" })
    @Permissions([PermissionName.TRANSACTIONS_READ])
    @Get(":transactionId/audit-logs")
    async getTransactionAuditLogs(@Param("transactionId") transactionId: string) {
        return this.adminTransactionService.getTransactionAuditLogs(transactionId);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Update transaction status manually" })
    @Permissions([PermissionName.TRANSACTIONS_UPDATE])
    @Put(":transactionId/status")
    async updateTransactionStatus(
        @Param("transactionId") transactionId: string,
        @Body() dto: UpdateTransactionStatusDto,
        @Req() req: any,
    ) {
        const adminId = req.user?.id;
        return this.adminTransactionService.updateTransactionStatus(transactionId, dto, adminId);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Manually approve a pending transaction" })
    @Permissions([PermissionName.TRANSACTIONS_APPROVE])
    @Post(":transactionId/approve")
    async manualApproveTransaction(
        @Param("transactionId") transactionId: string,
        @Body() dto: ManualApproveTransactionDto,
        @User() admin: UserModel,
    ) {
        return this.adminTransactionService.manualApproveTransaction(transactionId, dto, admin);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Initiate a refund for a transaction" })
    @Permissions([PermissionName.TRANSACTIONS_REFUND])
    @Post(":transactionId/refund")
    async refundTransaction(
        @Param("transactionId") transactionId: string,
        @Body() dto: RefundTransactionDto,
        @Req() req: any,
    ) {
        const adminId = req.user?.id;
        return this.adminTransactionService.refundTransaction(transactionId, dto, adminId);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Retry a failed transaction" })
    @Permissions([PermissionName.TRANSACTIONS_UPDATE])
    @Post(":transactionId/retry")
    async retryTransaction(
        @Param("transactionId") transactionId: string,
        @Req() req: any,
    ) {
        const adminId = req.user?.id;
        return this.adminTransactionService.retryTransaction(transactionId, adminId);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Bulk update transaction status" })
    @Permissions([PermissionName.TRANSACTIONS_UPDATE])
    @Post("bulk/status")
    async bulkUpdateStatus(
        @Body() dto: BulkTransactionActionDto,
        @Req() req: any,
    ) {
        const adminId = req.user?.id;
        return this.adminTransactionService.bulkUpdateStatus(dto, adminId);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Export transactions to CSV" })
    @Permissions([PermissionName.TRANSACTIONS_EXPORT])
    @Get("export/csv")
    async exportTransactions(@Query() query: GetUserTransactionListDto) {
        return this.adminTransactionService.exportTransactions(query, "csv");
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Sync deposits from Quidax for a user" })
    @Permissions([PermissionName.TRANSACTIONS_UPDATE])
    @Post("sync-deposits/:userId")
    async syncUserDeposits(@Param("userId", ParseIntPipe) userId: number) {
        return this.tradingService.syncUserDeposits(userId);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Debug: Get Quidax wallet info for a user" })
    @Permissions([PermissionName.TRANSACTIONS_READ])
    @Get("debug-wallet/:userId/:currency")
    async debugWallet(
        @Param("userId", ParseIntPipe) userId: number,
        @Param("currency") currency: string,
    ) {
        return this.tradingService.debugUserWallet(userId, currency);
    }
}
