import {
    Controller,
    Get,
    Post,
    Body,
    Query,
    Res,
    UseGuards,
} from "@nestjs/common";
import { Response } from "express";
import { ReportsService } from "../../../services/reports.service";
import { JwtAuthGuard } from "@/modules/api/auth/guards";
import { RolesGuard } from "@/modules/api/rbac/guards";
import { Roles } from "@/modules/api/rbac/decorators";
import { ReportConfig, ReportFilters } from "../../../types";

@Controller("admin/reports")
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminReportsController {
    constructor(private readonly reportsService: ReportsService) {}

    /**
     * Get available report types
     */
    @Get()
    @Roles("view_analytics", "export_reports")
    async getAvailableReports() {
        return this.reportsService.getAvailableReports();
    }

    /**
     * Generate and download a report
     */
    @Post("generate")
    @Roles("export_reports")
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

        res.setHeader("Content-Type", result.contentType);
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${result.filename}"`
        );
        res.setHeader("X-Report-Row-Count", result.rowCount.toString());
        res.setHeader("X-Report-Generated-At", result.generatedAt.toISOString());

        return res.send(result.data);
    }

    /**
     * Preview a report (returns JSON regardless of format)
     */
    @Post("preview")
    @Roles("view_analytics", "export_reports")
    async previewReport(@Body() config: ReportConfig) {
        // Force JSON format for preview
        const previewConfig = { ...config, format: "json" as const };

        // Parse date strings to Date objects if present
        if (previewConfig.filters.startDate && typeof previewConfig.filters.startDate === "string") {
            previewConfig.filters.startDate = new Date(previewConfig.filters.startDate);
        }
        if (previewConfig.filters.endDate && typeof previewConfig.filters.endDate === "string") {
            previewConfig.filters.endDate = new Date(previewConfig.filters.endDate);
        }

        const result = await this.reportsService.generateReport(previewConfig);

        return {
            rowCount: result.rowCount,
            generatedAt: result.generatedAt,
            preview: JSON.parse(result.data).slice(0, 20), // First 20 rows for preview
        };
    }

    /**
     * Generate transaction report
     */
    @Get("transactions")
    @Roles("export_reports")
    async getTransactionReport(
        @Query("startDate") startDate?: string,
        @Query("endDate") endDate?: string,
        @Query("currency") currency?: string,
        @Query("status") status?: string,
        @Query("orderCategory") orderCategory?: string,
        @Query("format") format: "csv" | "json" = "json",
        @Res() res?: Response
    ) {
        const filters: ReportFilters = {
            startDate: startDate ? new Date(startDate) : undefined,
            endDate: endDate ? new Date(endDate) : undefined,
            currency,
            status,
            orderCategory,
        };

        const config: ReportConfig = {
            type: "transactions",
            format,
            filters,
        };

        const result = await this.reportsService.generateReport(config);

        if (format === "csv" && res) {
            res.setHeader("Content-Type", result.contentType);
            res.setHeader(
                "Content-Disposition",
                `attachment; filename="${result.filename}"`
            );
            return res.send(result.data);
        }

        return {
            rowCount: result.rowCount,
            generatedAt: result.generatedAt,
            data: JSON.parse(result.data),
        };
    }

    /**
     * Generate user report
     */
    @Get("users")
    @Roles("export_reports")
    async getUserReport(
        @Query("startDate") startDate?: string,
        @Query("endDate") endDate?: string,
        @Query("userType") userType?: string,
        @Query("country") country?: string,
        @Query("format") format: "csv" | "json" = "json",
        @Res() res?: Response
    ) {
        const filters: ReportFilters = {
            startDate: startDate ? new Date(startDate) : undefined,
            endDate: endDate ? new Date(endDate) : undefined,
            userType,
            country,
        };

        const config: ReportConfig = {
            type: "users",
            format,
            filters,
        };

        const result = await this.reportsService.generateReport(config);

        if (format === "csv" && res) {
            res.setHeader("Content-Type", result.contentType);
            res.setHeader(
                "Content-Disposition",
                `attachment; filename="${result.filename}"`
            );
            return res.send(result.data);
        }

        return {
            rowCount: result.rowCount,
            generatedAt: result.generatedAt,
            data: JSON.parse(result.data),
        };
    }

    /**
     * Generate revenue report
     */
    @Get("revenue")
    @Roles("export_reports")
    async getRevenueReport(
        @Query("startDate") startDate?: string,
        @Query("endDate") endDate?: string,
        @Query("currency") currency?: string,
        @Query("orderCategory") orderCategory?: string,
        @Query("format") format: "csv" | "json" = "json",
        @Res() res?: Response
    ) {
        const filters: ReportFilters = {
            startDate: startDate ? new Date(startDate) : undefined,
            endDate: endDate ? new Date(endDate) : undefined,
            currency,
            orderCategory,
        };

        const config: ReportConfig = {
            type: "revenue",
            format,
            filters,
        };

        const result = await this.reportsService.generateReport(config);

        if (format === "csv" && res) {
            res.setHeader("Content-Type", result.contentType);
            res.setHeader(
                "Content-Disposition",
                `attachment; filename="${result.filename}"`
            );
            return res.send(result.data);
        }

        return {
            rowCount: result.rowCount,
            generatedAt: result.generatedAt,
            data: JSON.parse(result.data),
        };
    }

    /**
     * Generate tax report
     */
    @Get("tax")
    @Roles("export_reports")
    async getTaxReport(
        @Query("startDate") startDate?: string,
        @Query("endDate") endDate?: string,
        @Query("format") format: "csv" | "json" = "json",
        @Res() res?: Response
    ) {
        const filters: ReportFilters = {
            startDate: startDate ? new Date(startDate) : undefined,
            endDate: endDate ? new Date(endDate) : undefined,
        };

        const config: ReportConfig = {
            type: "tax",
            format,
            filters,
        };

        const result = await this.reportsService.generateReport(config);

        if (format === "csv" && res) {
            res.setHeader("Content-Type", result.contentType);
            res.setHeader(
                "Content-Disposition",
                `attachment; filename="${result.filename}"`
            );
            return res.send(result.data);
        }

        return {
            rowCount: result.rowCount,
            generatedAt: result.generatedAt,
            data: JSON.parse(result.data),
        };
    }
}
