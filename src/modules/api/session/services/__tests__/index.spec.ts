const buildResponseMock = jest.fn((payload) => payload);
const getBotTrafficReasonMock = jest.fn();
const isCloudProviderIPMock = jest.fn();
const isSuspiciousCombinationMock = jest.fn();

jest.mock("@/utils/api-response-util", () => ({
    __esModule: true,
    buildResponse: buildResponseMock,
}));

jest.mock("@/modules/api/session/utils/bot-detection", () => ({
    __esModule: true,
    getBotTrafficReason: getBotTrafficReasonMock,
    isCloudProviderIP: isCloudProviderIPMock,
    isSuspiciousCombination: isSuspiciousCombinationMock,
}));

jest.mock("@/config", () => ({
    __esModule: true,
    REFRESH_TOKEN_EXPIRATION: "7d",
}));

import { HttpStatus } from "@nestjs/common";
import { SessionService } from "../index";
import {
    InvalidSessionException,
    SessionNotFoundException,
} from "../../errors";

const ip = (...parts: number[]) => parts.join(".");

describe("SessionService", () => {
    const prisma = {
        session: {
            updateMany: jest.fn(),
            create: jest.fn(),
            findMany: jest.fn(),
            findFirst: jest.fn(),
            update: jest.fn(),
            deleteMany: jest.fn(),
            count: jest.fn(),
        },
    };

    const user = {
        id: 14,
    } as any;

    let service: SessionService;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new SessionService(prisma as any);

        getBotTrafficReasonMock.mockReturnValue(null);
        isCloudProviderIPMock.mockReturnValue(false);
        isSuspiciousCombinationMock.mockReturnValue(false);
    });

    it("createSession deactivates previous current session and creates a new one", async () => {
        prisma.session.updateMany.mockResolvedValue({ count: 2 });
        prisma.session.create.mockResolvedValue({ id: "session-1" });
        getBotTrafficReasonMock.mockReturnValue("possible bot");

        const result = await service.createSession(14, {
            deviceName: "Chrome on macOS",
            browser: "Chrome",
            os: "macOS",
            ipAddress: ip(1, 2, 3, 4),
            location: "Lagos",
        });

        expect(prisma.session.updateMany).toHaveBeenCalledWith({
            where: { userId: 14, isCurrent: true },
            data: { isCurrent: false },
        });
        expect(prisma.session.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    userId: 14,
                    isActive: true,
                    isCurrent: true,
                    expiresAt: expect.any(Date),
                }),
            })
        );
        expect(result).toEqual({ sessionId: "session-1" });
    });

    it("getUserSessions marks the provided sessionId as current", async () => {
        const now = new Date();
        prisma.session.findMany.mockResolvedValue([
            {
                id: "s1",
                deviceName: "Chrome",
                deviceType: "desktop",
                browser: "Chrome",
                os: "macOS",
                ipAddress: ip(1, 1, 1, 1),
                location: "Lagos",
                isActive: true,
                isCurrent: false,
                lastActiveAt: now,
                createdAt: now,
            },
            {
                id: "s2",
                deviceName: "Safari",
                deviceType: "mobile",
                browser: "Safari",
                os: "iOS",
                ipAddress: ip(2, 2, 2, 2),
                location: "Abuja",
                isActive: true,
                isCurrent: true,
                lastActiveAt: now,
                createdAt: now,
            },
        ]);

        const response = await service.getUserSessions(user, "s1");

        expect(response.message).toBe("Sessions retrieved successfully");
        expect(response.data.totalCount).toBe(2);
        expect(response.data.sessions[0].isCurrent).toBe(true);
        expect(response.data.sessions[1].isCurrent).toBe(false);
    });

    it("revokeSession throws SessionNotFoundException when session is missing", async () => {
        prisma.session.findFirst.mockResolvedValue(null);

        await expect(service.revokeSession(user, "missing", "current")).rejects.toBeInstanceOf(
            SessionNotFoundException
        );
    });

    it("revokeSession blocks current session revocation", async () => {
        prisma.session.findFirst.mockResolvedValue({ id: "current", userId: 14 });

        await expect(service.revokeSession(user, "current", "current")).rejects.toBeInstanceOf(
            InvalidSessionException
        );

        await expect(service.revokeSession(user, "current", "current")).rejects.toMatchObject({
            status: HttpStatus.BAD_REQUEST,
        });
    });

    it("extendSession returns early when called too frequently", async () => {
        const recentLastActive = new Date(Date.now() - 10_000);
        const existingExpiry = new Date(Date.now() + 60_000);

        prisma.session.findFirst.mockResolvedValue({
            id: "s1",
            userId: 14,
            isActive: true,
            lastActiveAt: recentLastActive,
            expiresAt: existingExpiry,
        });

        const response = await service.extendSession(user, "s1");

        expect(response.message).toBe("Session already recently extended");
        expect(response.data.expiresAt).toBe(existingExpiry);
        expect(prisma.session.update).not.toHaveBeenCalled();
    });

    it("extendSession updates expiry for stale session", async () => {
        prisma.session.findFirst.mockResolvedValue({
            id: "s2",
            userId: 14,
            isActive: true,
            lastActiveAt: new Date(Date.now() - 5 * 60 * 1000),
            expiresAt: new Date(Date.now() + 60_000),
        });
        prisma.session.update.mockResolvedValue({ id: "s2" });

        const response = await service.extendSession(user, "s2");

        expect(prisma.session.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "s2" },
                data: expect.objectContaining({
                    expiresAt: expect.any(Date),
                    lastActiveAt: expect.any(Date),
                }),
            })
        );
        expect(response.message).toBe("Session extended successfully");
    });

    it("cleanupBotSessions deactivates sessions flagged as cloud+suspicious", async () => {
        prisma.session.findMany.mockResolvedValue([
            {
                id: "bot-1",
                browser: "Safari",
                os: "Linux",
                ipAddress: ip(3, 10, 10, 10),
                deviceName: "health-check",
            },
            {
                id: "real-1",
                browser: "Chrome",
                os: "Windows",
                ipAddress: ip(196, 1, 1, 1),
                deviceName: "desktop",
            },
        ]);
        prisma.session.updateMany.mockResolvedValue({ count: 1 });

        isCloudProviderIPMock.mockImplementation((ip: string) => ip.startsWith("3."));
        isSuspiciousCombinationMock.mockImplementation(
            (browser: string, os: string) => browser.toLowerCase().includes("safari") && os.toLowerCase().includes("linux")
        );

        const result = await service.cleanupBotSessions();

        expect(result).toBe(1);
        expect(prisma.session.updateMany).toHaveBeenCalledWith({
            where: { id: { in: ["bot-1"] } },
            data: { isActive: false },
        });
    });

    it("cleanupBotSessions returns 0 when no sessions are flagged", async () => {
        prisma.session.findMany.mockResolvedValue([
            {
                id: "real-1",
                browser: "Chrome",
                os: "Windows",
                ipAddress: ip(196, 1, 1, 1),
                deviceName: "desktop",
            },
        ]);

        const result = await service.cleanupBotSessions();

        expect(result).toBe(0);
        expect(prisma.session.updateMany).not.toHaveBeenCalled();
    });

    it("invalidateCurrentSession returns already-invalid message for missing session", async () => {
        prisma.session.findFirst.mockResolvedValue(null);

        const response = await service.invalidateCurrentSession(user, "s-none");

        expect(response.message).toBe("Session already invalid or not found");
        expect(prisma.session.update).not.toHaveBeenCalled();
    });

    it("validateSession returns false for missing session and true when present", async () => {
        prisma.session.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "s1" });

        const missingResult = await service.validateSession("missing");
        const foundResult = await service.validateSession("s1");

        expect(missingResult).toBe(false);
        expect(foundResult).toBe(true);
    });
});
