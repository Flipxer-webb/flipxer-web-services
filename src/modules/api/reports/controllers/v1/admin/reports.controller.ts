import {
    Controller,
    Get,
    Post,
    Body,
    Res,
    UseGuards,
} from "@nestjs/common";
import { Response } from "express";
import { ReportsService } from "../../../services/reports.service";
import { AuthGuard, EnabledAccountGuard } from "@/modules/api/auth/guard";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { PermissionGuard } from "@/modules/api/authorize/guards/permission.guard";
import { UserTypes, ADMIN_USER_TYPES } from "@/modules/api/authorize/decorator";
import { UserType } from "@prisma/client";
import { ReportConfig, ReportFilters } from "../../../types";
import { buildResponse } from "@/utils/api-response-util";

@Controller("admin/reports")
@UseGuards(AuthGuard, RoleGuard, EnabledAccountGuard, PermissionGuard)
@UserTypes(ADMIN_USER_TYPES)
export class AdminReportsController {
    constructor(private readonly reportsService: ReportsService) { }

    /**
     * Get available report types
     */
    @Get()
    getAvailableReports() {
        const reports = this.reportsService.getAvailableReports();
        return buildResponse({
            message: "Available reports retrieved successfully",
            data: reports,
        });
    }

    /**
     * Preview a report (returns summary and sample data)
     */
    @Post("preview")
    async previewReport(@Body() config: ReportConfig) {
        // Parse date strings to Date objects if present
        if (config.filters?.startDate && typeof config.filters.startDate === "string") {
            config.filters.startDate = new Date(config.filters.startDate);
        }
        if (config.filters?.endDate && typeof config.filters.endDate === "string") {
            config.filters.endDate = new Date(config.filters.endDate);
        }

        const preview = await this.reportsService.previewReport(config);
        return buildResponse({
            message: "Report preview generated successfully",
            data: preview,
        });
    }

    /**
     * Generate and download a report (main endpoint for frontend)
     */
    @Post()
    async downloadReport(
        @Body() config: ReportConfig,
        @Res() res: Response
    ) {
        // Parse date strings to Date objects if present
        if (config.filters?.startDate && typeof config.filters.startDate === "string") {
            config.filters.startDate = new Date(config.filters.startDate);
        }
        if (config.filters?.endDate && typeof config.filters.endDate === "string") {
            config.filters.endDate = new Date(config.filters.endDate);
        }

        const result = await this.reportsService.generateReport(config);

        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Type", result.contentType);
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${result.filename}"`
        );
        res.send(result.data);
    }

    /**
     * Generate and download a report (alternate endpoint)
     */
    @Post("generate")
    async generateReport(
        @Body() config: ReportConfig,
        @Res() res: Response
    ) {
        // Parse date strings to Date objects if present
        if (config.filters.startDate && typeof config.filters.startDate === "string") {
            config.filters.startDate = new Date(config.filters.startDate);
        }
        if (config.filters.endDate && typeof config.filters.endDate === "string") {
            config.filters.endDate = new Date(config.filters.endDate);
        }

        const result = await this.reportsService.generateReport(config);

        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Type", result.contentType);
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${result.filename}"`
        );
        res.send(result.data);
    }

    /**
     * Generate transaction report
     */
    @Post("transactions")
    async generateTransactionReport(
        @Body() body: { filters: ReportFilters; format?: "csv" | "json" },
        @Res() res: Response
    ) {
        const config: ReportConfig = {
            type: "transactions",
            format: body.format || "csv",
            filters: body.filters,
        };

        // Parse date strings
        if (config.filters.startDate && typeof config.filters.startDate === "string") {
            config.filters.startDate = new Date(config.filters.startDate);
        }
        if (config.filters.endDate && typeof config.filters.endDate === "string") {
            config.filters.endDate = new Date(config.filters.endDate);
        }

        const result = await this.reportsService.generateReport(config);

        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Type", result.contentType);
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${result.filename}"`
        );
        res.send(result.data);
    }

    /**
     * Generate user report
     */
    @Post("users")
    async generateUserReport(
        @Body() body: { filters: ReportFilters; format?: "csv" | "json" },
        @Res() res: Response
    ) {
        const config: ReportConfig = {
            type: "users",
            format: body.format || "csv",
            filters: body.filters,
        };

        // Parse date strings
        if (config.filters.startDate && typeof config.filters.startDate === "string") {
            config.filters.startDate = new Date(config.filters.startDate);
        }
        if (config.filters.endDate && typeof config.filters.endDate === "string") {
            config.filters.endDate = new Date(config.filters.endDate);
        }

        const result = await this.reportsService.generateReport(config);

        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Type", result.contentType);
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${result.filename}"`
        );
        res.send(result.data);
    }

    /**
     * Generate revenue report
     */
    @Post("revenue")
    async generateRevenueReport(
        @Body() body: { filters: ReportFilters; format?: "csv" | "json" },
        @Res() res: Response
    ) {
        const config: ReportConfig = {
            type: "revenue",
            format: body.format || "csv",
            filters: body.filters,
        };

        // Parse date strings
        if (config.filters.startDate && typeof config.filters.startDate === "string") {
            config.filters.startDate = new Date(config.filters.startDate);
        }
        if (config.filters.endDate && typeof config.filters.endDate === "string") {
            config.filters.endDate = new Date(config.filters.endDate);
        }

        const result = await this.reportsService.generateReport(config);

        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Type", result.contentType);
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${result.filename}"`
        );
        res.send(result.data);
    }

    /**
     * Generate tax report
     */
    @Post("tax")
    async generateTaxReport(
        @Body() body: { filters: ReportFilters; format?: "csv" | "json" },
        @Res() res: Response
    ) {
        const config: ReportConfig = {
            type: "tax",
            format: body.format || "csv",
            filters: body.filters,
        };

        // Parse date strings
        if (config.filters.startDate && typeof config.filters.startDate === "string") {
            config.filters.startDate = new Date(config.filters.startDate);
        }
        if (config.filters.endDate && typeof config.filters.endDate === "string") {
            config.filters.endDate = new Date(config.filters.endDate);
        }

        const result = await this.reportsService.generateReport(config);

        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Type", result.contentType);
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${result.filename}"`
        );
        res.send(result.data);
    }
}
