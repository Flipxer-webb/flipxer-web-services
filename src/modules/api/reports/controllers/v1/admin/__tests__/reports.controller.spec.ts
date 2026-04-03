import { Test, TestingModule } from "@nestjs/testing";

jest.mock("@/modules/api/auth/guard", () => ({
    AuthGuard: class { isStub() { return true; } },
    EnabledAccountGuard: class { isStub() { return true; } },
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/guards/role.guard", () => ({
    RoleGuard: class { isStub() { return true; } },
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/guards/permission.guard", () => ({
    PermissionGuard: class { isStub() { return true; } },
    __esModule: true,
}));

import { AdminReportsController } from "../reports.controller";
import { ReportsService } from "../../../../services/reports.service";

type MockFn = jest.Mock<any, any>;

describe("AdminReportsController", () => {
    let controller: AdminReportsController;
    let reportsService: {
        getAvailableReports: MockFn;
        previewReport: MockFn;
        generateReport: MockFn;
    };

    const responseFactory = () => ({
        setHeader: jest.fn(),
        send: jest.fn(),
    });

    const generated = {
        contentType: "text/csv",
        filename: "report.csv",
        data: "id,name\n1,Alice",
    };

    beforeEach(async () => {
        reportsService = {
            getAvailableReports: jest.fn(),
            previewReport: jest.fn(),
            generateReport: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            controllers: [AdminReportsController],
            providers: [{ provide: ReportsService, useValue: reportsService }],
        }).compile();

        controller = module.get(AdminReportsController);
    });

    afterEach(() => jest.clearAllMocks());

    it("returns available reports", () => {
        reportsService.getAvailableReports.mockReturnValue([{ type: "transactions" }]);

        const result = controller.getAvailableReports();

        expect(result.message).toBe("Available reports retrieved successfully");
        expect(result.data).toEqual([{ type: "transactions" }]);
    });

    it("previews report and converts date strings", async () => {
        reportsService.previewReport.mockResolvedValue({ rows: 2 });

        const config: any = {
            type: "transactions",
            format: "csv",
            filters: {
                startDate: "2026-01-01T00:00:00.000Z",
                endDate: "2026-01-31T00:00:00.000Z",
            },
        };

        const result = await controller.previewReport(config);

        expect(config.filters.startDate).toBeInstanceOf(Date);
        expect(config.filters.endDate).toBeInstanceOf(Date);
        expect(reportsService.previewReport).toHaveBeenCalledWith(config);
        expect(result.data).toEqual({ rows: 2 });
    });

    it("downloads report and sets response headers", async () => {
        reportsService.generateReport.mockResolvedValue(generated);
        const res = responseFactory();
        const config: any = {
            type: "revenue",
            format: "csv",
            filters: {
                startDate: "2026-01-01T00:00:00.000Z",
                endDate: "2026-01-05T00:00:00.000Z",
            },
        };

        await controller.downloadReport(config, res as any);

        expect(config.filters.startDate).toBeInstanceOf(Date);
        expect(config.filters.endDate).toBeInstanceOf(Date);
        expect(res.setHeader).toHaveBeenNthCalledWith(1, "X-Content-Type-Options", "nosniff");
        expect(res.setHeader).toHaveBeenNthCalledWith(2, "Content-Type", "text/csv");
        expect(res.setHeader).toHaveBeenNthCalledWith(
            3,
            "Content-Disposition",
            "attachment; filename=\"report.csv\""
        );
        expect(res.send).toHaveBeenCalledWith("id,name\n1,Alice");
    });

    it("generates report from alternate endpoint", async () => {
        reportsService.generateReport.mockResolvedValue(generated);
        const res = responseFactory();
        const config: any = {
            type: "users",
            format: "json",
            filters: {
                startDate: "2026-02-01T00:00:00.000Z",
                endDate: "2026-02-28T00:00:00.000Z",
            },
        };

        await controller.generateReport(config, res as any);

        expect(reportsService.generateReport).toHaveBeenCalledWith(config);
        expect(config.filters.startDate).toBeInstanceOf(Date);
        expect(config.filters.endDate).toBeInstanceOf(Date);
        expect(res.send).toHaveBeenCalledWith(generated.data);
    });

    it("generates typed reports with default format and parsed dates", async () => {
        reportsService.generateReport.mockResolvedValue(generated);

        const calls: Array<{
            handler: (body: any, res: any) => Promise<void>;
            expectedType: "transactions" | "users" | "revenue" | "tax";
        }> = [
            { handler: (body, res) => controller.generateTransactionReport(body, res), expectedType: "transactions" },
            { handler: (body, res) => controller.generateUserReport(body, res), expectedType: "users" },
            { handler: (body, res) => controller.generateRevenueReport(body, res), expectedType: "revenue" },
            { handler: (body, res) => controller.generateTaxReport(body, res), expectedType: "tax" },
        ];

        for (const call of calls) {
            const res = responseFactory();
            const body: any = {
                filters: {
                    startDate: "2026-03-01T00:00:00.000Z",
                    endDate: "2026-03-31T00:00:00.000Z",
                },
            };

            await call.handler(body, res as any);

            const passedConfig = reportsService.generateReport.mock.calls.at(-1)?.[0];
            expect(passedConfig.type).toBe(call.expectedType);
            expect(passedConfig.format).toBe("csv");
            expect(passedConfig.filters.startDate).toBeInstanceOf(Date);
            expect(passedConfig.filters.endDate).toBeInstanceOf(Date);
            expect(res.setHeader).toHaveBeenCalledWith("X-Content-Type-Options", "nosniff");
            expect(res.send).toHaveBeenCalledWith(generated.data);
        }
    });
});
