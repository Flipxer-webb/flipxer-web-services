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
import { SUPPORTED_ASSETS } from "@/modules/api/trade/constants";
import { SupportedAssets } from "@/modules/api/trade/interfaces/trade";
import { buildResponse } from "@/utils/api-response-util";
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
import { AuditLogService } from "@/modules/api/audit-log";

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
        private readonly auditLogService: AuditLogService,
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
    async syncUserDeposits(@Param("userId", ParseIntPipe) userId: number, @Req() req: any) {
        const result = await this.tradingService.syncUserDeposits(userId);
        await this.auditLogService.log({
            action: "SYNC_USER_DEPOSITS",
            resource: "transaction",
            resourceId: userId.toString(),
            details: { userId },
            adminId: req.user?.id,
            ipAddress: req.ip,
            userAgent: req.headers?.["user-agent"],
        });
        return result;
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

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Debug: Get all wallet-address records for a user grouped by asset" })
    @Permissions([PermissionName.TRANSACTIONS_READ])
    @Get("wallet-address-records/:userId")
    async getWalletAddressRecords(
        @Param("userId", ParseIntPipe) userId: number,
    ) {
        return this.tradingService.getUserWalletAddressRecords(userId);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Trigger wallet address update for a user across all supported assets" })
    @Permissions([PermissionName.TRANSACTIONS_UPDATE])
    @Post("trigger-wallet-update/:userId")
    async triggerWalletUpdate(@Param("userId", ParseIntPipe) userId: number, @Req() req: any) {
        const results: Record<string, { status: string; addressCount: number }> = {};

        for (const asset of SUPPORTED_ASSETS) {
            try {
                const response = await this.tradingService.getWalletAddresses(userId, { asset: asset.toLowerCase() as SupportedAssets });
                const addresses = response?.data ?? [];
                results[asset] = { status: "ok", addressCount: Array.isArray(addresses) ? addresses.length : 0 };
            } catch (error) {
                results[asset] = { status: `error: ${error.message}`, addressCount: 0 };
            }
        }

        await this.auditLogService.log({
            action: "TRIGGER_WALLET_UPDATE",
            resource: "wallet",
            resourceId: userId.toString(),
            details: { userId, assetsProcessed: Object.keys(results) },
            adminId: req.user?.id,
            ipAddress: req.ip,
            userAgent: req.headers?.["user-agent"],
        });

        return buildResponse({
            message: "wallet update triggered",
            data: results,
        });
    }
}
