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
import { IWsNewNotification } from "../../interfaces/trade";
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
