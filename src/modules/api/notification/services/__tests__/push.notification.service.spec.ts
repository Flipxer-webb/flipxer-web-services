jest.mock("firebase-admin", () => {
    const apps: any[] = [];
    const sendMock = jest.fn();
    const sendEachForMulticastMock = jest.fn();
    const initializeAppMock = jest.fn();
    const certMock = jest.fn();
    const messagingMock = jest.fn(() => ({
        send: sendMock,
        sendEachForMulticast: sendEachForMulticastMock,
    }));

    return {
        __esModule: true,
        apps,
        initializeApp: initializeAppMock,
        credential: {
            cert: certMock,
        },
        messaging: messagingMock,
        __mock: {
            apps,
            sendMock,
            sendEachForMulticastMock,
            initializeAppMock,
            certMock,
            messagingMock,
        },
    };
});

import * as admin from "firebase-admin";
import { PushNotificationService } from "../push.notification.service";

describe("PushNotificationService", () => {
    const prisma = {
        deviceToken: {
            findMany: jest.fn(),
            deleteMany: jest.fn(),
        },
        user: {
            findUnique: jest.fn(),
            findMany: jest.fn(),
            updateMany: jest.fn(),
        },
    };

    let service: PushNotificationService;
    let firebaseMock: any;

    const payload = {
        title: "Test Title",
        body: "Test Body",
        data: { category: "marketing" },
    };

    beforeEach(() => {
        jest.clearAllMocks();

        firebaseMock = (admin as any).__mock;
        firebaseMock.apps.length = 0;

        delete process.env.FIREBASE_PROJECT_ID;
        delete process.env.FIREBASE_CLIENT_EMAIL;
        delete process.env.FIREBASE_PRIVATE_KEY;

        service = new PushNotificationService(prisma as any);
    });

    it("stays unavailable when firebase credentials are missing", () => {
        service.onModuleInit();

        expect(service.isAvailable()).toBe(false);
        expect(firebaseMock.initializeAppMock).not.toHaveBeenCalled();
    });

    it("initializes firebase when credentials are present and no app exists", () => {
        process.env.FIREBASE_PROJECT_ID = "project-id";
        process.env.FIREBASE_CLIENT_EMAIL = "admin@flipxer.com";
        process.env.FIREBASE_PRIVATE_KEY = "line1\\nline2";

        service.onModuleInit();

        expect(firebaseMock.certMock).toHaveBeenCalledWith({
            projectId: "project-id",
            clientEmail: "admin@flipxer.com",
            privateKey: "line1\nline2",
        });
        expect(firebaseMock.initializeAppMock).toHaveBeenCalledTimes(1);
        expect(service.isAvailable()).toBe(true);
    });

    it("marks service available when firebase app already exists", () => {
        process.env.FIREBASE_PROJECT_ID = "project-id";
        process.env.FIREBASE_CLIENT_EMAIL = "admin@flipxer.com";
        process.env.FIREBASE_PRIVATE_KEY = "line1\\nline2";
        firebaseMock.apps.push({ name: "default" });

        service.onModuleInit();

        expect(firebaseMock.initializeAppMock).not.toHaveBeenCalled();
        expect(service.isAvailable()).toBe(true);
    });

    it("returns false for sendToDevice when firebase is not initialized", async () => {
        const result = await service.sendToDevice("token-1", payload);

        expect(result).toBe(false);
        expect(firebaseMock.sendMock).not.toHaveBeenCalled();
    });

    it("returns false for sendToDevice when token is empty", async () => {
        (service as any).isInitialized = true;

        const result = await service.sendToDevice("", payload);

        expect(result).toBe(false);
        expect(firebaseMock.sendMock).not.toHaveBeenCalled();
    });

    it("sends push to one device successfully", async () => {
        (service as any).isInitialized = true;
        firebaseMock.sendMock.mockResolvedValue("message-id");

        const result = await service.sendToDevice("token-1", {
            ...payload,
            imageUrl: "https://img.example.com/banner.png",
        });

        expect(result).toBe(true);
        expect(firebaseMock.sendMock).toHaveBeenCalledWith(
            expect.objectContaining({
                token: "token-1",
                data: expect.objectContaining({
                    title: "Test Title",
                    body: "Test Body",
                    imageUrl: "https://img.example.com/banner.png",
                }),
            })
        );
    });

    it("invalidates token on invalid registration token error", async () => {
        (service as any).isInitialized = true;
        firebaseMock.sendMock.mockRejectedValue({
            message: "invalid",
            code: "messaging/invalid-registration-token",
        });

        const result = await service.sendToDevice("bad-token", payload);

        expect(result).toBe(false);
        expect(prisma.deviceToken.deleteMany).toHaveBeenCalledWith({
            where: { token: "bad-token" },
        });
        expect(prisma.user.updateMany).toHaveBeenCalledWith({
            where: { notificationToken: "bad-token" },
            data: { notificationToken: null },
        });
    });

    it("returns empty result for sendToMultipleDevices when no valid tokens", async () => {
        (service as any).isInitialized = true;

        const result = await service.sendToMultipleDevices(["", "   "], payload);

        expect(result).toEqual({ successCount: 0, failureCount: 0, failedTokens: [] });
        expect(firebaseMock.sendEachForMulticastMock).not.toHaveBeenCalled();
    });

    it("collects failed multicast tokens and invalidates them", async () => {
        (service as any).isInitialized = true;
        firebaseMock.sendEachForMulticastMock.mockResolvedValue({
            successCount: 1,
            failureCount: 1,
            responses: [
                { success: true },
                {
                    success: false,
                    error: { code: "messaging/registration-token-not-registered" },
                },
            ],
        });

        const result = await service.sendToMultipleDevices(["token-ok", "token-bad"], payload);

        expect(result).toEqual({
            successCount: 1,
            failureCount: 1,
            failedTokens: ["token-bad"],
        });
        expect(prisma.deviceToken.deleteMany).toHaveBeenCalledWith({
            where: { token: { in: ["token-bad"] } },
        });
        expect(prisma.user.updateMany).toHaveBeenCalledWith({
            where: { notificationToken: { in: ["token-bad"] } },
            data: { notificationToken: null },
        });
    });

    it("uses legacy user token fallback when sendToUser has no device tokens", async () => {
        (service as any).isInitialized = true;
        prisma.deviceToken.findMany.mockResolvedValue([]);
        prisma.user.findUnique.mockResolvedValue({ notificationToken: "legacy-token" });
        const sendToDeviceSpy = jest
            .spyOn(service, "sendToDevice")
            .mockResolvedValue(true);

        const result = await service.sendToUser(10, payload);

        expect(result).toBe(true);
        expect(sendToDeviceSpy).toHaveBeenCalledWith("legacy-token", payload);
    });

    it("returns false for sendToUser when user has no tokens anywhere", async () => {
        (service as any).isInitialized = true;
        prisma.deviceToken.findMany.mockResolvedValue([]);
        prisma.user.findUnique.mockResolvedValue({ notificationToken: null });

        const result = await service.sendToUser(10, payload);

        expect(result).toBe(false);
    });

    it("uses multicast for sendToUser when user has multiple device tokens", async () => {
        (service as any).isInitialized = true;
        prisma.deviceToken.findMany.mockResolvedValue([{ token: "t1" }, { token: "t2" }]);
        const sendToMultipleSpy = jest
            .spyOn(service, "sendToMultipleDevices")
            .mockResolvedValue({ successCount: 1, failureCount: 1, failedTokens: ["t2"] });

        const result = await service.sendToUser(20, payload);

        expect(result).toBe(true);
        expect(sendToMultipleSpy).toHaveBeenCalledWith(["t1", "t2"], payload);
    });

    it("deduplicates tokens across device and legacy records in sendToUsers", async () => {
        prisma.deviceToken.findMany.mockResolvedValue([
            { userId: 1, token: "shared-token" },
            { userId: 2, token: "device-only" },
        ]);
        prisma.user.findMany.mockResolvedValue([
            { notificationToken: "shared-token" },
            { notificationToken: "legacy-only" },
        ]);
        const sendToMultipleSpy = jest
            .spyOn(service, "sendToMultipleDevices")
            .mockResolvedValue({ successCount: 2, failureCount: 0, failedTokens: [] });

        const result = await service.sendToUsers([1, 2, 3], payload);

        expect(result.successCount).toBe(2);
        expect(sendToMultipleSpy).toHaveBeenCalledWith(
            expect.arrayContaining(["shared-token", "device-only", "legacy-only"]),
            payload
        );
    });

    it("returns failure count based on users when sendToUsers throws", async () => {
        prisma.deviceToken.findMany.mockRejectedValue(new Error("db failed"));

        const result = await service.sendToUsers([7, 8, 9], payload);

        expect(result).toEqual({ successCount: 0, failureCount: 3, failedTokens: [] });
    });
});