import { AuditLogService } from "../audit-log.service";

describe("AuditLogService", () => {
    let service: AuditLogService;

    const mockPrisma = {
        auditLog: {
            create: jest.fn(),
        },
    };

    beforeEach(() => {
        jest.clearAllMocks();
        service = new AuditLogService(mockPrisma as any);
    });

    describe("log", () => {
        it("should create an audit log entry with all fields", async () => {
            mockPrisma.auditLog.create.mockResolvedValue({ id: "1" });

            await service.log({
                action: "CREATE_USER",
                resource: "user",
                resourceId: "user-123",
                details: { name: "Test User" },
                adminId: 1,
                ipAddress: "127.0.0.1",
                userAgent: "test-agent",
            });

            expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
                data: {
                    action: "CREATE_USER",
                    resource: "user",
                    resourceId: "user-123",
                    details: { name: "Test User" },
                    adminId: 1,
                    ipAddress: "127.0.0.1",
                    userAgent: "test-agent",
                },
            });
        });

        it("should default details to empty object when not provided", async () => {
            mockPrisma.auditLog.create.mockResolvedValue({ id: "2" });

            await service.log({
                action: "DELETE_USER",
                resource: "user",
            });

            expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
                data: {
                    action: "DELETE_USER",
                    resource: "user",
                    resourceId: undefined,
                    details: {},
                    adminId: undefined,
                    ipAddress: undefined,
                    userAgent: undefined,
                },
            });
        });

        it("should not throw when prisma fails", async () => {
            mockPrisma.auditLog.create.mockRejectedValue(
                new Error("DB connection failed"),
            );

            await expect(
                service.log({
                    action: "UPDATE_SETTINGS",
                    resource: "settings",
                    adminId: 1,
                }),
            ).resolves.toBeUndefined();
        });
    });

    describe("logWithContext", () => {
        it("should delegate to log with context fields", async () => {
            mockPrisma.auditLog.create.mockResolvedValue({ id: "3" });

            await service.logWithContext(
                "APPROVE_KYC",
                "kyc",
                {
                    adminId: 2,
                    ipAddress: "10.0.0.1",
                    userAgent: "Mozilla/5.0",
                },
                "kyc-456",
                { level: "TIER_2" },
            );

            expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
                data: {
                    action: "APPROVE_KYC",
                    resource: "kyc",
                    resourceId: "kyc-456",
                    details: { level: "TIER_2" },
                    adminId: 2,
                    ipAddress: "10.0.0.1",
                    userAgent: "Mozilla/5.0",
                },
            });
        });

        it("should handle missing optional parameters", async () => {
            mockPrisma.auditLog.create.mockResolvedValue({ id: "4" });

            await service.logWithContext("VIEW_DASHBOARD", "dashboard", {
                adminId: 3,
            });

            expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
                data: {
                    action: "VIEW_DASHBOARD",
                    resource: "dashboard",
                    resourceId: undefined,
                    details: {},
                    adminId: 3,
                    ipAddress: undefined,
                    userAgent: undefined,
                },
            });
        });
    });

    describe("extractContext", () => {
        it("should extract context from a request object", () => {
            const req = {
                user: { id: 5 },
                ip: "192.168.1.1",
                headers: { "user-agent": "Chrome/120" },
            };

            const context = AuditLogService.extractContext(req);

            expect(context).toEqual({
                adminId: 5,
                ipAddress: "192.168.1.1",
                userAgent: "Chrome/120",
            });
        });

        it("should handle missing request fields gracefully", () => {
            const context = AuditLogService.extractContext({});

            expect(context).toEqual({
                adminId: undefined,
                ipAddress: undefined,
                userAgent: undefined,
            });
        });

        it("should handle null request", () => {
            const context = AuditLogService.extractContext(null);

            expect(context).toEqual({
                adminId: undefined,
                ipAddress: undefined,
                userAgent: undefined,
            });
        });
    });
});
