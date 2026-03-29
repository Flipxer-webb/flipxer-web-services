import { WsGateway } from "../index";

describe("WsGateway", () => {
    let gateway: WsGateway;
    let wsService: {
        handleConnection: jest.Mock;
        handlePostConnection: jest.Mock;
        emitNotificationToUser: jest.Mock;
        emitTransactionUpdateToUser: jest.Mock;
        emitWalletUpdateToUser: jest.Mock;
        emitToAdmins: jest.Mock;
        broadcastWalletUpdates: jest.Mock;
        getNotifications: jest.Mock;
        getUserWallets: jest.Mock;
        handleDisconnect: jest.Mock;
    };
    let server: { to: jest.Mock };
    let emitMock: jest.Mock;

    beforeEach(() => {
        wsService = {
            handleConnection: jest.fn(),
            handlePostConnection: jest.fn(),
            emitNotificationToUser: jest.fn(),
            emitTransactionUpdateToUser: jest.fn(),
            emitWalletUpdateToUser: jest.fn(),
            emitToAdmins: jest.fn(),
            broadcastWalletUpdates: jest.fn(),
            getNotifications: jest.fn(),
            getUserWallets: jest.fn(),
            handleDisconnect: jest.fn(),
        };

        gateway = new WsGateway(wsService as never);

        emitMock = jest.fn();
        server = {
            to: jest.fn().mockReturnValue({ emit: emitMock }),
        };
        (gateway as any).server = server;
    });

    it("delegates connection and query handlers", async () => {
        const client = { id: "socket-1" };
        wsService.handlePostConnection.mockResolvedValue({ ok: true });
        wsService.getNotifications.mockResolvedValue({ rows: [] });
        wsService.getUserWallets.mockResolvedValue({ wallets: [] });

        gateway.handleConnection(client as never);
        await expect(gateway.handlePostConnection(client as never)).resolves.toEqual({ ok: true });
        await expect(gateway.handleGetNotifications(client as never)).resolves.toEqual({ rows: [] });
        await expect(gateway.handleGetUserWallets(client as never, [{}, "44"] as never)).resolves.toEqual({ wallets: [] });

        gateway.handleDisconnect(client as never);

        expect(wsService.handleConnection).toHaveBeenCalledWith(client);
        expect(wsService.handlePostConnection).toHaveBeenCalledWith(client);
        expect(wsService.getNotifications).toHaveBeenCalledWith(client);
        expect(wsService.getUserWallets).toHaveBeenCalledWith(client, {});
        expect(wsService.handleDisconnect).toHaveBeenCalledWith(client);
    });

    it("delegates user notifications and wallet updates", () => {
        gateway.notifyUser(7, { title: "Hello" } as never);
        gateway.notifyTransactionUpdate(7, { transactionType: "deposit" } as never);
        gateway.notifyWalletUpdate(7);
        gateway.broadcastWalletUpdatesToUser();

        expect(wsService.emitNotificationToUser).toHaveBeenCalledWith(7, { title: "Hello" }, server);
        expect(wsService.emitTransactionUpdateToUser).toHaveBeenCalledWith(7, { transactionType: "deposit" }, server);
        expect(wsService.emitWalletUpdateToUser).toHaveBeenCalledWith(7, server);
        expect(wsService.broadcastWalletUpdates).toHaveBeenCalledWith(server);
    });

    it("emits withdrawal queued and admin broadcast", () => {
        const payload = {
            queueId: "q-1",
            currency: "BTC",
            amount: "10.5",
            position: 2,
            reason: "liquidity",
        };

        gateway.notifyWithdrawalQueued(15, payload);

        expect(server.to).toHaveBeenCalledWith("user:15");
        expect(emitMock).toHaveBeenCalledWith("withdrawalQueued", payload);
        expect(wsService.emitToAdmins).toHaveBeenCalledWith(
            "admin:withdrawalQueued",
            expect.objectContaining({
                userId: 15,
                amount: 10.5,
                currency: "BTC",
                position: 2,
                reason: "liquidity",
            }),
            server,
        );
    });

    it("emits withdrawal processed and triggers wallet update", () => {
        gateway.notifyWithdrawalProcessed(21, {
            queueId: "q-2",
            currency: "ETH",
            amount: "1.25",
        });

        expect(server.to).toHaveBeenCalledWith("user:21");
        expect(emitMock).toHaveBeenCalledWith("withdrawalProcessed", {
            queueId: "q-2",
            currency: "ETH",
            amount: "1.25",
        });
        expect(wsService.emitToAdmins).toHaveBeenCalledWith(
            "admin:withdrawalProcessed",
            expect.objectContaining({ userId: 21, amount: 1.25, currency: "ETH" }),
            server,
        );
        expect(wsService.emitWalletUpdateToUser).toHaveBeenCalledWith(21, server);
    });

    it("emits queue health and profile updates", () => {
        gateway.notifyQueueHealthAlert({
            category: "withdrawal",
            title: "Delay",
            message: "Queue delay detected",
            severity: "warning",
        });
        gateway.notifyProfileUpdate(9);

        expect(wsService.emitToAdmins).toHaveBeenCalledWith(
            "admin:queueHealthAlert",
            expect.objectContaining({
                category: "withdrawal",
                title: "Delay",
                message: "Queue delay detected",
                severity: "warning",
                timestamp: expect.any(String),
            }),
            server,
        );
        expect(server.to).toHaveBeenCalledWith("user:9");
        expect(emitMock).toHaveBeenCalledWith(
            "profileUpdate",
            expect.objectContaining({ timestamp: expect.any(String) }),
        );
    });
});
