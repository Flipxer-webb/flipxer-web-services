import {
    MessageBody,
    SubscribeMessage,
    WebSocketGateway,
    WebSocketServer,
    OnGatewayConnection,
    OnGatewayDisconnect,
    ConnectedSocket,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { UseGuards, UsePipes } from "@nestjs/common";
import { Notification, UserType } from "@prisma/client";
import { whitelist } from "@/config";
import { WsService } from "../../services/websocket.service";

import { UserTypes } from "@/modules/api/authorize/decorator";
import { WsValidatorPipeInstance } from "@/core/exception/ws/pipe";
import { SocketAuthGuard } from "@/modules/api/auth/guard";
import { SocketRoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { IWsNewNotification, IWsTransactionUpdate } from "../../interfaces/trade";
import { GetUserAssetsDto } from "@/modules/api/user/dtos";

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
export class WsGateway implements OnGatewayConnection, OnGatewayDisconnect {
    constructor(private readonly wsService: WsService) {}

    @WebSocketServer()
    server: Server;

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

    @SubscribeMessage("getNotifications")
    async handleGetNotifications(@ConnectedSocket() client: Socket) {
        return await this.wsService.getNotifications(client);
    }

    @SubscribeMessage("getUserWallets")
    async handleGetUserWallets(
        @ConnectedSocket() client: Socket,
        @MessageBody() [data, userId]: [GetUserAssetsDto, string]
    ) {
        return await this.wsService.getUserWallets(client, data);
    }

    handleDisconnect(client: Socket) {
        this.wsService.handleDisconnect(client);
    }
}
