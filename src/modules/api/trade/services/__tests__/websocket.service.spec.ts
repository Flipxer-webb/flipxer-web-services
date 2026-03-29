import { Logger } from "@nestjs/common";
import { UserType } from "@prisma/client";
import { WsService } from "../websocket.service";

jest.mock("@/modules/api/user", () => {
    class AccountDeletedException extends Error { constructor() { super("Account deleted"); } }
    class UserNotFoundException extends Error { constructor() { super("User not found"); } }
    return {
        User: () => () => {},
        ClientData: () => () => {},
        UserModule: class { readonly __stub = true },
        AccountDeletedException,
        UserNotFoundException,
        __esModule: true,
    };
});

describe("WsService", () => {
    let service: WsService;
    let prismaService: { notification: { findMany: jest.Mock } };
    let userService: { getUserWallets: jest.Mock };

    const makeServer = () => {
        const emit = jest.fn();
        const to = jest.fn().mockReturnValue({ emit });
        return { to, emit };
    };

    const makeClient = (overrides: Record<string, any> = {}) => ({
        id: "socket-1",
        data: {
            user: {
                id: 7,
                userType: UserType.INDIVIDUAL,
            },
        },
        join: jest.fn(),
        ...overrides,
    });

    beforeEach(() => {
        prismaService = {
            notification: {
                findMany: jest.fn().mockResolvedValue([{ id: 1 }]),
            },
        };
        userService = {
            getUserWallets: jest.fn().mockResolvedValue({ data: [{ asset: "BTC", balance: "1" }] }),
        };

        service = new WsService(prismaService as any, userService as any);

        jest.spyOn(Logger, "log").mockImplementation(() => undefined);
        jest.spyOn(Logger, "warn").mockImplementation(() => undefined);
        jest.spyOn(Logger, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("handles initial connection", async () => {
        const client = makeClient();
        await expect(service.handleConnection(client as any)).resolves.toBeUndefined();
        expect(Logger.log).toHaveBeenCalledWith("Client connected: socket-1");
    });

    it("registers socket mapping and joins user/admin rooms", async () => {
        const adminClient = makeClient({
            id: "socket-admin",
            data: { user: { id: 99, userType: UserType.ADMIN } },
        });

        const result = await service.handlePostConnection(adminClient as any);

        expect(adminClient.join).toHaveBeenCalledWith("user:99");
        expect(adminClient.join).toHaveBeenCalledWith("admin");
        expect(result.message).toBe("post connection successful");
    });

    it("emits events to admins room", () => {
        const server = makeServer();

        service.emitToAdmins("ops.alert", { critical: true }, server as any);

        expect(server.to).toHaveBeenCalledWith("admin");
        expect(server.emit).toHaveBeenCalledWith("ops.alert", { critical: true });
    });

    it("emits notifications and transaction updates to connected users", async () => {
        const client = makeClient();
        await service.handlePostConnection(client as any);
        const server = makeServer();

        service.emitNotificationToUser(7, { title: "n" } as any, server as any);
        service.emitTransactionUpdateToUser(7, { transactionId: "tx-1" } as any, server as any);

        expect(server.to).toHaveBeenCalledWith("socket-1");
        expect(server.emit).toHaveBeenCalledWith(
            "notification",
            expect.objectContaining({ message: "new Notification" })
        );
        expect(server.emit).toHaveBeenCalledWith(
            "transactionUpdate",
            expect.objectContaining({ message: "transaction updated" })
        );
    });

    it("warns when trying to emit to disconnected users", () => {
        const server = makeServer();

        service.emitNotificationToUser(11, { title: "n" } as any, server as any);
        service.emitTransactionUpdateToUser(11, { transactionId: "tx-1" } as any, server as any);

        expect(Logger.warn).toHaveBeenCalled();
    });

    it("emits wallet updates and handles wallet fetch errors", async () => {
        const client = makeClient();
        await service.handlePostConnection(client as any);
        const server = makeServer();

        await service.emitWalletUpdateToUser(7, server as any);

        expect(userService.getUserWallets).toHaveBeenCalledWith(7, {});
        expect(server.emit).toHaveBeenCalledWith(
            "walletAssetsUpdate",
            expect.objectContaining({ message: "wallet assets update" })
        );

        userService.getUserWallets.mockRejectedValueOnce(new Error("wallet fetch failed"));
        await service.emitWalletUpdateToUser(7, server as any);

        expect(Logger.error).toHaveBeenCalled();
    });

    it("returns notifications and delegates getUserWallets", async () => {
        const client = makeClient();

        const notifications = await service.getNotifications(client as any);
        const wallets = await service.getUserWallets(client as any, { asset: "btc" } as any);

        expect(prismaService.notification.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { userId: 7 },
                take: 20,
            })
        );
        expect(notifications.message).toBe("notification list retrieved");
        expect(userService.getUserWallets).toHaveBeenCalledWith(7, { asset: "btc" });
        expect(wallets).toEqual({ data: [{ asset: "BTC", balance: "1" }] });
    });

    it("broadcasts wallet updates to mapped sockets and ignores missing server", async () => {
        const noServerResult = await service.broadcastWalletUpdates(undefined as any);
        expect(noServerResult).toBeUndefined();

        (service as any).userSocketMap.set("7", "socket-1");
        (service as any).userSocketMap.set("8", "socket-2");

        userService.getUserWallets
            .mockResolvedValueOnce({ data: [{ asset: "BTC" }] })
            .mockRejectedValueOnce(new Error("boom"));

        const server = makeServer();
        await service.broadcastWalletUpdates(server as any);

        expect(server.to).toHaveBeenCalledWith("socket-1");
        expect(Logger.error).toHaveBeenCalled();
    });

    it("cleans up socket mappings on disconnect", async () => {
        const client = makeClient();
        await service.handlePostConnection(client as any);

        service.handleDisconnect(client as any);

        expect((service as any).userSocketMap.size).toBe(0);
        expect((service as any).socketUserMap.size).toBe(0);
        expect(Logger.log).toHaveBeenCalledWith("Client disconnected: socket-1");
    });
});