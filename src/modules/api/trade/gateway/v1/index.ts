import {
    SubscribeMessage,
    WebSocketGateway,
    WebSocketServer,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnGatewayInit,
    ConnectedSocket,
    WsException,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { UseGuards, UsePipes } from "@nestjs/common";
import { whitelist } from "@/config";
import { WsService } from "../../services/websocket.service";

import { WsValidatorPipeInstance } from "@/core/exception/ws/pipe";
import { SocketAuthGuard } from "@/modules/api/auth/guard";
import { IWsNewNotification, IWsTransactionUpdate } from "../../interfaces/trade";

@UseGuards(SocketAuthGuard)
@UsePipes(WsValidatorPipeInstance())
@WebSocketGateway({
    namespace: "/v1/trades",
    cors: {
        origin: whitelist,
    },
    transports: ["websocket", "polling"],
    connectionStateRecovery: {},
})
export class WsGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
    constructor(
        private readonly wsService: WsService,
        private readonly socketAuthGuard: SocketAuthGuard
    ) {}

    @WebSocketServer()
    server: Server;

    afterInit(server: Server) {
        server.use(async (client, next) => {
            try {
                await this.socketAuthGuard.authenticateClient(client);
                next();
            } catch (error) {
                const message = this.getHandshakeErrorMessage(error);
                const authError = new Error(message) as Error & {
                    data?: { status: string; message: string };
                };

                authError.data = {
                    status: "error",
                    message,
                };

                next(authError);
            }
        });
    }

    handleConnection(client: Socket) {
        this.wsService.handleConnection(client);
    }

    @SubscribeMessage("postConnection")
    async handlePostConnection(@ConnectedSocket() client: Socket) {
        return await this.wsService.handlePostConnection(client);
    }

    notifyUser(userId: number, payload: IWsNewNotification) {
        this.wsService.emitNotificationToUser(userId, payload, this.server);
    }

    notifyTransactionUpdate(userId: number, payload: IWsTransactionUpdate) {
        this.wsService.emitTransactionUpdateToUser(userId, payload, this.server);
    }

    notifyWalletUpdate(userId: number) {
        this.wsService.emitWalletUpdateToUser(userId, this.server);
    }

    /**
     * Notify user that their withdrawal has been queued
     */
    notifyWithdrawalQueued(userId: number, payload: {
        queueId: string;
        currency: string;
        amount: string;
        position: number;
        reason: string;
    }) {
        this.server.to(`user:${userId}`).emit("withdrawalQueued", payload);
        this.wsService.emitToAdmins("admin:withdrawalQueued", {
            userId,
            amount: Number(payload.amount),
            currency: payload.currency,
            position: payload.position,
            reason: payload.reason,
            queuedAt: new Date().toISOString(),
        }, this.server);
    }

    /**
     * Notify user that their queued withdrawal has been processed
     */
    notifyWithdrawalProcessed(userId: number, payload: {
        queueId: string;
        currency: string;
        amount: string;
    }) {
        this.server.to(`user:${userId}`).emit("withdrawalProcessed", payload);
        this.wsService.emitToAdmins("admin:withdrawalProcessed", {
            userId,
            amount: Number(payload.amount),
            currency: payload.currency,
            processedAt: new Date().toISOString(),
        }, this.server);
        // Also trigger wallet update since balance changed
        this.wsService.emitWalletUpdateToUser(userId, this.server);
    }

    /**
     * Notify user/admin that a queued withdrawal has been released back to the user
     */
    notifyWithdrawalReleased(userId: number, payload: {
        queueId: string;
        currency: string;
        amount: string;
        reason: string;
    }) {
        this.server.to(`user:${userId}`).emit("withdrawalReleased", payload);
        this.wsService.emitToAdmins("admin:withdrawalReleased", {
            userId,
            amount: Number(payload.amount),
            currency: payload.currency,
            reason: payload.reason,
            releasedAt: new Date().toISOString(),
        }, this.server);
        this.wsService.emitWalletUpdateToUser(userId, this.server);
    }

    notifyQueueHealthAlert(payload: {
        category: string;
        title: string;
        message: string;
        severity: "info" | "warning" | "error";
        timestamp?: string;
    }) {
        this.wsService.emitToAdmins("admin:queueHealthAlert", {
            ...payload,
            timestamp: payload.timestamp ?? new Date().toISOString(),
        }, this.server);
    }

    /**
     * Notify user that their profile has been updated (e.g. KYC approval/rejection)
     */
    notifyProfileUpdate(userId: number) {
        this.server.to(`user:${userId}`).emit("profileUpdate", {
            timestamp: new Date().toISOString(),
        });
    }

    broadcastWalletUpdatesToUser() {
        this.wsService.broadcastWalletUpdates(this.server);
    }

    /**
     * Broadcast price updates to all connected clients
     */
    broadcastPriceUpdate(prices: Record<string, { price: number; change24h?: number } | null>) {
        if (this.server) {
            this.server.emit("priceUpdate", {
                prices,
                timestamp: new Date().toISOString(),
            });
        }
    }

    handleDisconnect(client: Socket) {
        this.wsService.handleDisconnect(client);
    }

    private getHandshakeErrorMessage(error: unknown): string {
        if (error instanceof WsException) {
            const wsError = error.getError();

            if (typeof wsError === "string") {
                return wsError;
            }

            if (
                typeof wsError === "object" &&
                wsError !== null &&
                "message" in wsError &&
                typeof (wsError as { message?: unknown }).message === "string"
            ) {
                return (wsError as { message: string }).message;
            }
        }

        if (error instanceof Error && error.message) {
            return error.message;
        }

        return "Your session is unauthorized";
    }
}
