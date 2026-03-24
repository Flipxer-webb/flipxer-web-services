import {
    Controller,
    Get,
    Post,
    Body,
    Query,
    Param,
    UseGuards,
    Logger,
    ParseIntPipe,
    DefaultValuePipe,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags, ApiQuery } from "@nestjs/swagger";
import {
    AuthGuard,
    EnabledAccountGuard,
} from "@/modules/api/auth/guard";
import { UserTypes, Permissions } from "@/modules/api/authorize/decorator";
import { UserType, User as UserEntity } from "@prisma/client";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { PermissionGuard } from "@/modules/api/authorize/guards/permission.guard";
import { PermissionName } from "@/modules/api/authorize/enums/role";
import { User } from "@/modules/api/user/decorators";
import { ReconciliationService } from "../../services/ledger/reconciliation.service";
import { WithdrawalQueueService } from "../../services/ledger/withdrawal-queue.service";
import { FloatConfigService } from "../../services/ledger/float-config.service";
import { LedgerService } from "../../services/ledger/ledger.service";
import { SweepService } from "../../services/ledger/sweep.service";
import { OrphanedHoldService } from "../../services/ledger/orphaned-hold.service";
import { DepositReviewService } from "../../services/ledger/deposit-review.service";
import { SolvencyService } from "../../services/ledger/solvency.service";
import { HoldResolution } from "@prisma/client";
import { buildResponse } from "@/utils/api-response-util";

/**
 * Admin Ledger Controller
 *
 * Provides admin-only endpoints for managing the virtual balance ledger system.
 * All endpoints require:
 * - Valid authentication (AuthGuard)
 * - ADMIN user type (RoleGuard + UserTypes)
 * - Enabled account (EnabledAccountGuard)
 *
 * Endpoints:
 * - Reconciliation: View status, run reconciliation, acknowledge discrepancies
 * - Withdrawal Queue: View queue, pause/resume processing
 * - Float Status: View current float levels and alerts
 * - Solvency: Monitor platform reserves vs liabilities
 * - User Balance: Query user ledger balances
 */
@UseGuards(AuthGuard, RoleGuard, EnabledAccountGuard, PermissionGuard)
@UserTypes([UserType.ADMIN, UserType.SUPER_ADMIN])
@ApiTags("admin-ledger")
@ApiBearerAuth("access-token")
@Controller({
    path: "admin/ledger",
})
export class AdminLedgerController {
    private readonly logger = new Logger(AdminLedgerController.name);

    constructor(
        private readonly reconciliationService: ReconciliationService,
        private readonly withdrawalQueueService: WithdrawalQueueService,
        private readonly floatConfigService: FloatConfigService,
        private readonly ledgerService: LedgerService,
        private readonly sweepService: SweepService,
        private readonly orphanedHoldService: OrphanedHoldService,
        private readonly depositReviewService: DepositReviewService,
        private readonly solvencyService: SolvencyService
    ) { }

    // =========================================================================
    // RECONCILIATION ENDPOINTS
    // =========================================================================

    @ApiOperation({ summary: "Get last reconciliation result" })
    @Get("reconciliation/status")
    async getReconciliationStatus() {
        this.logger.log("Admin fetching reconciliation status");
        const results = await this.reconciliationService.getLatestReconciliations();
        return buildResponse({
            message: "Reconciliation status retrieved",
            data: Object.fromEntries(results),
        });
    }

    @ApiOperation({ summary: "Run reconciliation check now" })
    @Post("reconciliation/run")
    async runReconciliation() {
        this.logger.log("Admin triggering manual reconciliation");
        const result = await this.reconciliationService.runReconciliation();
        return buildResponse({
            message: "Reconciliation completed",
            data: result,
        });
    }

    @ApiOperation({ summary: "Acknowledge discrepancy and resume processing" })
    @Post("reconciliation/acknowledge")
    async acknowledgeDiscrepancy(
        @User() user: UserEntity,
        @Body() body: { currency: string; reason: string }
    ) {
        this.logger.log(
            `Admin ${user.id} acknowledging ${body.currency} discrepancy with reason: ${body.reason}`
        );
        await this.reconciliationService.acknowledgeAndResume(
            body.currency.toUpperCase(),
            user.id,
            body.reason
        );
        return buildResponse({
            message: "Discrepancy acknowledged and processing resumed",
        });
    }

    // =========================================================================
    // WITHDRAWAL QUEUE ENDPOINTS
    // =========================================================================

    @ApiOperation({ summary: "Get withdrawal queue status and items" })
    @ApiQuery({ name: "currency", required: false, description: "Filter by currency" })
    @Get("withdrawal-queue")
    async getWithdrawalQueue(@Query("currency") currency?: string) {
        this.logger.log("Admin fetching withdrawal queue");

        const queue = await this.withdrawalQueueService.getPendingQueue(currency);
        const isPaused = await this.withdrawalQueueService.isProcessingPaused();

        return buildResponse({
            message: "Withdrawal queue retrieved",
            data: {
                items: queue,
                count: queue.length,
                isPaused,
            },
        });
    }

    @ApiOperation({ summary: "Pause withdrawal queue processing" })
    @Post("withdrawal-queue/pause")
    async pauseWithdrawalQueue(@Body() body: { reason: string }) {
        this.logger.log(`Admin pausing withdrawal queue: ${body.reason}`);
        await this.withdrawalQueueService.pauseProcessing(body.reason);
        return buildResponse({
            message: "Withdrawal queue processing paused",
        });
    }

    @ApiOperation({ summary: "Resume withdrawal queue processing" })
    @Post("withdrawal-queue/resume")
    async resumeWithdrawalQueue() {
        this.logger.log("Admin resuming withdrawal queue");
        await this.withdrawalQueueService.resumeProcessing();
        return buildResponse({
            message: "Withdrawal queue processing resumed",
        });
    }

    @ApiOperation({ summary: "Process queue timeouts (release expired holds)" })
    @Post("withdrawal-queue/process-timeouts")
    async processWithdrawalQueueTimeouts() {
        this.logger.log("Admin triggering withdrawal queue timeout processing");
        const processed = await this.withdrawalQueueService.processTimeouts();
        return buildResponse({
            message: "Queue timeout processing completed",
            data: { processedCount: processed },
        });
    }

    @ApiOperation({ summary: "Get withdrawal queue statistics" })
    @Get("withdrawal-queue/stats")
    async getWithdrawalQueueStats(@Query("currency") currency?: string) {
        this.logger.log("Admin fetching withdrawal queue stats");
        const stats = await this.withdrawalQueueService.getAdminQueueStats(currency);
        return buildResponse({
            message: "Queue statistics retrieved",
            data: stats,
        });
    }

    // =========================================================================
    // FLOAT STATUS ENDPOINTS
    // =========================================================================

    @ApiOperation({ summary: "Get float configuration for all currencies" })
    @Get("float/config")
    async getFloatConfig() {
        this.logger.log("Admin fetching float configuration");
        const configs = await this.floatConfigService.getAllFloatConfigs();
        return buildResponse({
            message: "Float configuration retrieved",
            data: configs,
        });
    }

    // =========================================================================
    // USER BALANCE ENDPOINTS
    // =========================================================================

    @ApiOperation({ summary: "Get user ledger balance for a specific currency" })
    @Get("balance/:userId/:currency")
    async getUserBalance(
        @Param("userId", ParseIntPipe) userId: number,
        @Param("currency") currency: string
    ) {
        this.logger.log(`Admin fetching balance for user ${userId}, currency ${currency}`);
        const balance = await this.ledgerService.getBalance(userId, currency.toUpperCase());
        return buildResponse({
            message: "User balance retrieved",
            data: {
                userId,
                currency: currency.toUpperCase(),
                ...balance,
            },
        });
    }

    @ApiOperation({ summary: "Get user ledger balances for all currencies" })
    @Get("balance/:userId")
    async getUserBalances(
        @Param("userId", ParseIntPipe) userId: number
    ) {
        this.logger.log(`Admin fetching all balances for user ${userId}`);
        const balancesMap = await this.ledgerService.getAllBalances(userId);
        const balances = Array.from(balancesMap.entries()).map(([currency, info]) => ({
            userId,
            currency,
            available: info.available.toNumber(),
            held: info.held.toNumber(),
            total: info.total.toNumber(),
        }));
        return buildResponse({
            message: "User balances retrieved",
            data: balances,
        });
    }

    @ApiOperation({ summary: "Get user ledger history" })
    @ApiQuery({ name: "limit", required: false, description: "Max entries to return" })
    @Get("history/:userId/:currency")
    async getUserLedgerHistory(
        @Param("userId", ParseIntPipe) userId: number,
        @Param("currency") currency: string,
        @Query("limit") limit?: string
    ) {
        this.logger.log(`Admin fetching ledger history for user ${userId}, currency ${currency}`);

        const parsedLimit = limit ? parseInt(limit, 10) : 100;
        const history = await this.ledgerService.getHistory(
            userId,
            currency.toUpperCase(),
            parsedLimit
        );

        return buildResponse({
            message: "User ledger history retrieved",
            data: {
                userId,
                currency: currency.toUpperCase(),
                entries: history,
                count: history.length,
            },
        });
    }

    // =========================================================================
    // SWEEP STATUS ENDPOINTS
    // =========================================================================

    @ApiOperation({ summary: "Get pending sweeps" })
    @Get("sweeps/pending")
    async getPendingSweeps() {
        this.logger.log("Admin fetching pending sweeps");
        const sweeps = await this.sweepService.getPendingSweeps();
        return buildResponse({
            message: "Pending sweeps retrieved",
            data: {
                sweeps,
                count: sweeps.length,
            },
        });
    }

    @ApiOperation({ summary: "Process pending sweeps now" })
    @Post("sweeps/process")
    async processPendingSweeps() {
        this.logger.log("Admin triggering sweep processing");
        const processedCount = await this.sweepService.processPendingSweeps();
        return buildResponse({
            message: "Sweep processing completed",
            data: { processedCount },
        });
    }

    @ApiOperation({ summary: "Get sweep statistics" })
    @Get("sweeps/stats")
    async getSweepStats() {
        this.logger.log("Admin fetching sweep stats");
        const stats = await this.sweepService.getSweepStats();
        return buildResponse({
            message: "Sweep statistics retrieved",
            data: stats,
        });
    }

    @ApiOperation({ summary: "Resolve a stuck/failed sweep as NOT_APPLICABLE" })
    @Post("sweeps/:id/resolve")
    async resolveSweep(
        @Param("id") id: string,
        @User() admin: UserEntity,
        @Body("reason") reason?: string,
    ) {
        this.logger.log(`Admin ${admin.id} resolving sweep ${id}`);
        await this.sweepService.markNotApplicable(
            id,
            reason || `manually resolved by admin ${admin.id}`
        );
        return buildResponse({
            message: "Sweep resolved as NOT_APPLICABLE",
            data: { ledgerEntryId: id },
        });
    }

    @ApiOperation({ summary: "Retry failed sweeps now" })
    @Post("sweeps/retry")
    async retryFailedSweeps() {
        this.logger.log("Admin triggering failed sweep retry");
        const retriedCount = await this.sweepService.retryFailedSweeps();
        return buildResponse({
            message: "Failed sweep retry completed",
            data: { retriedCount },
        });
    }

    // =========================================================================
    // ORPHANED HOLD ENDPOINTS
    // =========================================================================

    @ApiOperation({ summary: "Get pending orphaned holds for review" })
    @Get("orphaned-holds")
    async getOrphanedHolds(
        @Query("pageNumber", new DefaultValuePipe(1), ParseIntPipe) pageNumber: number,
        @Query("pageSize", new DefaultValuePipe(10), ParseIntPipe) pageSize: number,
    ) {
        this.logger.log(`Admin fetching orphaned holds (page ${pageNumber})`);
        const reviews = await this.orphanedHoldService.getPendingReviews(pageNumber, pageSize);
        const stats = await this.orphanedHoldService.getStats();
        return buildResponse({
            message: "Orphaned holds retrieved",
            data: {
                reviews,
                count: reviews.length,
                stats,
            },
        });
    }

    @ApiOperation({ summary: "Get orphaned hold by ID" })
    @Get("orphaned-holds/:id")
    async getOrphanedHoldById(@Param("id") id: string) {
        this.logger.log(`Admin fetching orphaned hold ${id}`);
        const review = await this.orphanedHoldService.getReviewById(id);
        if (!review) {
            return buildResponse({
                message: "Orphaned hold not found",
                data: null,
            });
        }
        return buildResponse({
            message: "Orphaned hold retrieved",
            data: review,
        });
    }

    @ApiOperation({ summary: "Resolve orphaned hold with admin action" })
    @Post("orphaned-holds/:id/resolve")
    async resolveOrphanedHold(
        @User() user: UserEntity,
        @Param("id") id: string,
        @Body() body: { resolution: HoldResolution; notes?: string }
    ) {
        this.logger.log(`Admin ${user.id} resolving orphaned hold ${id} with ${body.resolution}`);

        const result = await this.orphanedHoldService.resolveOrphanedHold(
            id,
            body.resolution,
            user.id,
            body.notes
        );

        if (!result.success) {
            return buildResponse({
                message: result.error || "Failed to resolve orphaned hold",
                data: null,
            });
        }

        return buildResponse({
            message: "Orphaned hold resolved successfully",
            data: { resolution: body.resolution },
        });
    }

    @ApiOperation({ summary: "Manually trigger orphaned hold detection" })
    @Post("orphaned-holds/detect")
    async detectOrphanedHolds() {
        this.logger.log("Admin triggering orphaned hold detection");
        const result = await this.orphanedHoldService.detectOrphanedHolds();
        return buildResponse({
            message: "Orphaned hold detection completed",
            data: result,
        });
    }

    @ApiOperation({ summary: "Get orphaned hold statistics" })
    @Get("orphaned-holds-stats")
    async getOrphanedHoldStats() {
        this.logger.log("Admin fetching orphaned hold stats");
        const stats = await this.orphanedHoldService.getStats();
        return buildResponse({
            message: "Orphaned hold statistics retrieved",
            data: stats,
        });
    }

    // =========================================================================
    // AUDIT LOG ENDPOINTS
    // =========================================================================

    @ApiOperation({ summary: "Get audit trail for a ledger entry" })
    @Permissions([PermissionName.SYSTEM_AUDIT_LOGS])
    @Get("audit/:entryId")
    async getAuditTrail(@Param("entryId") entryId: string) {
        this.logger.log(`Admin fetching audit trail for entry ${entryId}`);
        const auditLogs = await this.ledgerService.getAuditTrail(entryId);
        return buildResponse({
            message: "Audit trail retrieved",
            data: {
                entryId,
                logs: auditLogs,
                count: auditLogs.length,
            },
        });
    }

    @ApiOperation({ summary: "Get recent audit logs" })
    @Permissions([PermissionName.SYSTEM_AUDIT_LOGS])
    @ApiQuery({ name: "pageNumber", required: false, description: "Page number (default: 1)" })
    @ApiQuery({ name: "pageSize", required: false, description: "Page size (default: 20)" })
    @ApiQuery({ name: "action", required: false, description: "Filter by action type" })
    @ApiQuery({ name: "search", required: false, description: "Search actor or reason" })
    @ApiQuery({ name: "startDate", required: false, description: "Start date (ISO)" })
    @ApiQuery({ name: "endDate", required: false, description: "End date (ISO)" })
    @Get("audit-logs")
    async getRecentAuditLogs(
        @Query("pageNumber", new DefaultValuePipe(1), ParseIntPipe) pageNumber: number,
        @Query("pageSize", new DefaultValuePipe(20), ParseIntPipe) pageSize: number,
        @Query("action") action?: string,
        @Query("search") search?: string,
        @Query("startDate") startDate?: string,
        @Query("endDate") endDate?: string,
    ) {
        this.logger.log(`Admin fetching recent audit logs (page ${pageNumber})`);
        const { logs, total } = await this.ledgerService.getRecentAuditLogs(
            pageNumber,
            pageSize,
            action as any,
            search,
            startDate,
            endDate,
        );
        return buildResponse({
            message: "Audit logs retrieved",
            data: {
                logs,
                count: total,
            },
        });
    }

    @ApiOperation({ summary: "Trigger backfill of audit logs for existing entries" })
    @Permissions([PermissionName.SYSTEM_AUDIT_LOGS])
    @Post("audit/backfill")
    async backfillAuditLogs(@Body() body: { limit?: number }) {
        this.logger.log(`Admin triggering audit log backfill (limit: ${body.limit || 1000})`);
        const count = await this.ledgerService.backfillAuditLogs(body.limit);
        return buildResponse({
            message: "Audit log backfill completed",
            data: {
                processedCount: count,
            },
        });
    }

    // =========================================================================
    // SOLVENCY MONITORING ENDPOINTS
    // =========================================================================

    @ApiOperation({ summary: "Get current platform solvency report" })
    @Get("solvency")
    async getSolvencyReport() {
        this.logger.log("Admin fetching solvency report");
        const report = await this.solvencyService.generateReport();
        return buildResponse({
            message: "Solvency report generated",
            data: report,
        });
    }

    @ApiOperation({ summary: "Get solvency history for a currency" })
    @ApiQuery({ name: "currency", required: true, description: "Currency to get history for" })
    @ApiQuery({ name: "days", required: false, description: "Number of days of history (default: 7)" })
    @Get("solvency/history")
    async getSolvencyHistory(
        @Query("currency") currency: string,
        @Query("days", new DefaultValuePipe(7), ParseIntPipe) days: number
    ) {
        this.logger.log(`Admin fetching solvency history for ${currency} (${days} days)`);
        const history = await this.solvencyService.getHistory(currency, days);
        return buildResponse({
            message: "Solvency history retrieved",
            data: {
                currency: currency.toUpperCase(),
                days,
                snapshots: history,
                count: history.length,
            },
        });
    }

    @ApiOperation({ summary: "Trigger manual solvency check with alerts" })
    @Post("solvency/check")
    async runSolvencyCheck() {
        this.logger.log("Admin triggering manual solvency check");
        await this.solvencyService.checkAndAlert();
        return buildResponse({
            message: "Solvency check completed",
        });
    }

    // =========================================================================
    // DEPOSIT REVIEW ENDPOINTS
    // =========================================================================

    @ApiOperation({ summary: "Get deposit reviews" })
    @Get("deposit-reviews")
    async getDepositReviews(
        @Query("pageNumber", new DefaultValuePipe(1), ParseIntPipe) pageNumber: number,
        @Query("pageSize", new DefaultValuePipe(10), ParseIntPipe) pageSize: number,
        @Query("status") status?: string,
        @Query("currency") currency?: string
    ) {
        this.logger.log(`Admin fetching deposit reviews (page ${pageNumber})`);
        const { reviews, count } = await this.depositReviewService.getReviews(
            pageNumber,
            pageSize,
            status as any,
            currency
        );
        return buildResponse({
            message: "Deposit reviews retrieved",
            data: {
                reviews,
                count,
            },
        });
    }

    @ApiOperation({ summary: "Approve a queued deposit" })
    @Post("deposit-reviews/:id/approve")
    async approveDeposit(
        @Param("id") id: string,
        @User() admin: UserEntity,
        @Body("notes") notes?: string
    ) {
        this.logger.log(`Admin ${admin.id} approving deposit ${id}`);
        const result = await this.depositReviewService.approveDeposit(id, admin.id, notes);
        if (!result.success) {
            return buildResponse({
                message: result.error || "Failed to approve deposit",
                data: null,
            });
        }
        return buildResponse({
            message: "Deposit approved successfully",
            data: result.entry,
        });
    }

    @ApiOperation({ summary: "Reject a queued deposit" })
    @Post("deposit-reviews/:id/reject")
    async rejectDeposit(
        @Param("id") id: string,
        @User() admin: UserEntity,
        @Body("notes") notes?: string
    ) {
        this.logger.log(`Admin ${admin.id} rejecting deposit ${id}`);
        const result = await this.depositReviewService.rejectDeposit(id, admin.id, notes);
        if (!result.success) {
            return buildResponse({
                message: result.error || "Failed to reject deposit",
                data: null,
            });
        }
        return buildResponse({
            message: "Deposit rejected",
            data: null,
        });
    }

    @ApiOperation({ summary: "Get deposit review queue statistics" })
    @Get("deposit-review-stats")
    async getDepositReviewStats(
        @Query("status") status?: string,
        @Query("currency") currency?: string,
    ) {
        this.logger.log("Admin fetching deposit review stats");
        const stats = await this.depositReviewService.getStats(status, currency);
        return buildResponse({
            message: "Deposit review statistics retrieved",
            data: stats,
        });
    }
}

