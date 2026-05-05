import { Test, TestingModule } from "@nestjs/testing";

jest.mock("@/config", () => ({
    jwtSecret: "test",
    jwt_refresh_secret: "test",
    TOKEN_EXPIRATION: "1h",
    REFRESH_TOKEN_EXPIRATION: "7d",
    COMPANY_NAME: "Flipxer",
    isProdEnvironment: false,
    emailTemplateConfig: {},
    mailConfig: { senderMail: "noreply@test.com" },
    storageDirConfig: {},
    cloudinaryConfig: {},
    imagekitConfig: {},
}));

import { ReportsService } from "../reports.service";
import { PrismaService } from "@/modules/core/prisma/services";

function makePrisma() {
    return {
        order: {
            findMany: jest.fn(),
        },
        user: {
            findMany: jest.fn(),
        },
    };
}

describe("ReportsService", () => {
    let service: ReportsService;
    let prisma: ReturnType<typeof makePrisma>;

    beforeEach(async () => {
        prisma = makePrisma();

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ReportsService,
                { provide: PrismaService, useValue: prisma },
            ],
        }).compile();

        service = module.get<ReportsService>(ReportsService);
    });

    describe("generateReport", () => {
        it("should generate a CSV transaction report", async () => {
            const mockOrder = {
                id: 1,
                createdAt: new Date("2025-06-01T00:00:00Z"),
                userId: 10,
                user: { id: 10, email: "u@test.com", firstName: "A", lastName: "B" },
                orderCategory: "BUY",
                fromCurrency: "BTC",
                toCurrency: "NGN",
                amount: 0.5,
                fromAmount: 0.5,
                currency: "BTC",
                fee: 0.01,
                total: 0.51,
                streamlinedStatus: "completed",
                orderReference: "ref-1",
                providerOrderId: "prov-1",
            };
            prisma.order.findMany.mockResolvedValue([mockOrder]);

            const result = await service.generateReport({
                type: "transactions",
                format: "csv",
                filters: {},
            });

            expect(result.filename).toContain("transactions_");
            expect(result.filename).toMatch(/\.csv$/);
            expect(result.contentType).toBe("text/csv");
            expect(result.rowCount).toBe(1);
            expect(result.data).toContain("u@test.com");
        });

        it("should generate a JSON transaction report", async () => {
            prisma.order.findMany.mockResolvedValue([]);

            const result = await service.generateReport({
                type: "transactions",
                format: "json",
                filters: {},
            });

            expect(result.filename).toMatch(/\.json$/);
            expect(result.contentType).toBe("application/json");
            expect(result.rowCount).toBe(0);
        });

        it("should generate a user report with aligned verification fields", async () => {
            const mockUser = {
                id: 1,
                identifier: "USR-001",
                email: "test@test.com",
                firstName: "John",
                lastName: "Doe",
                phone: "+1234",
                userType: "INDIVIDUAL",
                tier: 1,
                country: "NG",
                status: "ACTIVE",
                isEmailVerified: true,
                isPhoneVerified: true,
                isDocumentVerified: false,
                bvn: null,
                nin: null,
                kycStageAttempts: [
                    {
                        journeyType: "INDIVIDUAL",
                        stage: "GOVERNMENT_ID",
                        method: "NIN",
                        status: "APPROVED",
                        isCurrent: true,
                    },
                ],
                createdAt: new Date("2025-01-01"),
                lastLogin: new Date("2025-06-01"),
                loginCount: 5,
                isDeleted: false,
            };
            prisma.user.findMany.mockResolvedValue([mockUser]);

            const result = await service.generateReport({
                type: "users",
                format: "json",
                filters: {},
            });

            expect(result.filename).toContain("users_");
            expect(result.filename).toMatch(/\.json$/);
            expect(result.rowCount).toBe(1);
            const data = JSON.parse(result.data);
            expect(data[0]).toMatchObject({
                emailVerified: true,
                phoneVerified: true,
                governmentIdVerified: true,
                documentVerified: false,
            });
        });

        it("should generate a user report with filters", async () => {
            prisma.user.findMany.mockResolvedValue([]);

            const result = await service.generateReport({
                type: "users",
                format: "json",
                filters: {
                    userType: "INDIVIDUAL",
                    country: "NG",
                    startDate: new Date("2025-01-01"),
                    endDate: new Date("2025-12-31"),
                },
            });

            expect(result.rowCount).toBe(0);
        });

        it("should generate a revenue report", async () => {
            const orders = [
                {
                    createdAt: new Date("2025-06-01"),
                    orderCategory: "BUY",
                    currency: "BTC",
                    fromCurrency: null,
                    amount: 0.5,
                    fromAmount: null,
                    fee: 0,
                },
                {
                    createdAt: new Date("2025-06-01"),
                    orderCategory: "BUY",
                    currency: "BTC",
                    fromCurrency: null,
                    amount: 1,
                    fromAmount: null,
                    fee: 0.02,
                },
            ];
            prisma.order.findMany.mockResolvedValue(orders);

            const result = await service.generateReport({
                type: "revenue",
                format: "json",
                filters: {},
            });

            expect(result.filename).toContain("revenue_");
            const data = JSON.parse(result.data);
            expect(data).toHaveLength(1);
            expect(data[0].transactionCount).toBe(2);
            expect(data[0].totalVolume).toBe(1.5);
        });

        it("should generate a tax report", async () => {
            const orders = [
                {
                    userId: 1,
                    user: { id: 1, email: "a@t.com", firstName: "A", lastName: "B", userType: "INDIVIDUAL" },
                    orderCategory: "BUY",
                    amount: 100,
                    fromAmount: null,
                    fee: 5,
                    streamlinedStatus: "completed",
                },
                {
                    userId: 1,
                    user: { id: 1, email: "a@t.com", firstName: "A", lastName: "B", userType: "INDIVIDUAL" },
                    orderCategory: "SELL",
                    amount: 200,
                    fromAmount: null,
                    fee: 10,
                    streamlinedStatus: "completed",
                },
            ];
            prisma.order.findMany.mockResolvedValue(orders);

            const result = await service.generateReport({
                type: "tax",
                format: "json",
                filters: { startDate: new Date("2025-01-01"), endDate: new Date("2025-12-31") },
            });

            expect(result.filename).toContain("tax_");
            const data = JSON.parse(result.data);
            expect(data).toHaveLength(1);
            expect(data[0].totalBuyVolume).toBe(100);
            expect(data[0].totalSellVolume).toBe(200);
        });

        it("should throw for unknown report type", async () => {
            await expect(
                service.generateReport({ type: "unknown" as any, format: "csv", filters: {} })
            ).rejects.toThrow("Unknown report type");
        });
    });

    describe("generateReport - filters", () => {
        it("should apply date range and currency filters", async () => {
            prisma.order.findMany.mockResolvedValue([]);

            await service.generateReport({
                type: "transactions",
                format: "csv",
                filters: {
                    startDate: new Date("2025-01-01"),
                    endDate: new Date("2025-12-31"),
                    currency: "BTC",
                    status: "completed",
                    orderCategory: "BUY",
                },
            });

            const whereArg = prisma.order.findMany.mock.calls[0][0].where;
            expect(whereArg.createdAt.gte).toEqual(new Date("2025-01-01"));
            expect(whereArg.createdAt.lte).toEqual(new Date("2025-12-31"));
            expect(whereArg.OR).toBeDefined();
            expect(whereArg.streamlinedStatus).toBe("completed");
            expect(whereArg.orderCategory).toBe("BUY");
        });
    });

    describe("generateReport - CSV formatting", () => {
        it("should handle CSV with commas and quotes in values", async () => {
            const mockOrder = {
                id: 1,
                createdAt: new Date("2025-06-01T00:00:00Z"),
                userId: 10,
                user: { id: 10, email: "u@test.com", firstName: 'John "Jr"', lastName: "Doe, III" },
                orderCategory: "BUY",
                fromCurrency: "BTC",
                toCurrency: "NGN",
                amount: 1,
                fromAmount: 1,
                currency: "BTC",
                fee: 0,
                total: 1,
                streamlinedStatus: "completed",
                orderReference: null,
                providerOrderId: null,
            };
            prisma.order.findMany.mockResolvedValue([mockOrder]);

            const result = await service.generateReport({
                type: "transactions",
                format: "csv",
                filters: {},
            });

            // Commas and quotes in values should be properly escaped
            expect(result.data).toContain('"John ""Jr"" Doe, III"');
        });

        it("should produce empty string for empty data", async () => {
            prisma.order.findMany.mockResolvedValue([]);

            const result = await service.generateReport({
                type: "transactions",
                format: "csv",
                filters: {},
            });

            expect(result.data).toBe("");
        });

        it("should respect includeHeaders false", async () => {
            const mockOrder = {
                id: 1,
                createdAt: new Date("2025-06-01T00:00:00Z"),
                userId: 10,
                user: { id: 10, email: "u@t.com", firstName: "A", lastName: "B" },
                orderCategory: "BUY",
                fromCurrency: "BTC",
                toCurrency: "NGN",
                amount: 1,
                fromAmount: 1,
                currency: "BTC",
                fee: 0,
                total: 1,
                streamlinedStatus: "completed",
                orderReference: "ref",
                providerOrderId: null,
            };
            prisma.order.findMany.mockResolvedValue([mockOrder]);

            const result = await service.generateReport({
                type: "transactions",
                format: "csv",
                filters: {},
                includeHeaders: false,
            });

            // Should not contain "id" header row
            const lines = result.data.split("\n");
            expect(lines).toHaveLength(1);
        });
    });

    describe("previewReport", () => {
        it("should return preview with columns and sample data", async () => {
            prisma.order.findMany.mockResolvedValue([
                {
                    id: 1,
                    createdAt: new Date("2025-06-01"),
                    userId: 1,
                    user: { id: 1, email: "a@t.com", firstName: "A", lastName: "B" },
                    orderCategory: "BUY",
                    fromCurrency: "BTC",
                    toCurrency: "NGN",
                    amount: 1,
                    fromAmount: 1,
                    currency: "BTC",
                    fee: 0,
                    total: 1,
                    streamlinedStatus: "completed",
                    orderReference: "ref",
                    providerOrderId: null,
                },
            ]);

            const preview = await service.previewReport({
                type: "transactions",
                format: "csv",
                filters: {},
            });

            expect(preview.totalRecords).toBe(1);
            expect(preview.columns).toContain("id");
            expect(preview.columns).toContain("userEmail");
            expect(preview.sampleData).toHaveLength(1);
            expect(preview.estimatedSize).toBeDefined();
        });

        it("should handle empty data preview", async () => {
            prisma.order.findMany.mockResolvedValue([]);

            const preview = await service.previewReport({
                type: "transactions",
                format: "csv",
                filters: {},
            });

            expect(preview.totalRecords).toBe(0);
            expect(preview.sampleData).toHaveLength(0);
        });

        it("should throw for unknown preview type", async () => {
            await expect(
                service.previewReport({ type: "unknown" as any, format: "csv", filters: {} })
            ).rejects.toThrow("Unknown report type");
        });

        it("should preview users report type", async () => {
            prisma.user.findMany.mockResolvedValue([]);

            const preview = await service.previewReport({
                type: "users",
                format: "csv",
                filters: {},
            });

            expect(preview.columns).toContain("email");
        });

        it("should preview revenue report type", async () => {
            prisma.order.findMany.mockResolvedValue([]);

            const preview = await service.previewReport({
                type: "revenue",
                format: "csv",
                filters: {},
            });

            expect(preview.columns).toContain("date");
        });

        it("should preview tax report type", async () => {
            prisma.order.findMany.mockResolvedValue([]);

            const preview = await service.previewReport({
                type: "tax",
                format: "csv",
                filters: {},
            });

            expect(preview.columns).toContain("userId");
        });
    });

    describe("getAvailableReports", () => {
        it("should return available report types", () => {
            const reports = service.getAvailableReports();
            expect(reports).toBeInstanceOf(Array);
            expect(reports.length).toBeGreaterThanOrEqual(4);
            const types = reports.map((r: any) => r.type);
            expect(types).toContain("transactions");
            expect(types).toContain("users");
            expect(types).toContain("revenue");
            expect(types).toContain("tax");
        });
    });
});
