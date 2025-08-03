import { forwardRef, Injectable, Logger } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import * as Utils from "@/utils";
import { Socket } from "socket.io";

import { User, UserType } from "@prisma/client";
import { Server } from "socket.io";
import { IWsNewNotification } from "../interfaces/trade";
import { GetUserAssetsDto } from "../../user/dtos";
import { UserService } from "../../user/services";

@Injectable()
export class WsService {
    private userSocketMap: Map<string, string> = new Map(); // userId -> socketId
    private socketUserMap: Map<string, string> = new Map(); // socketId -> userId
    constructor(
        private prismaService: PrismaService,
        @Inject(forwardRef(() => UserService))
        private readonly userService: UserService
    ) {}

    /**
     *  @description initial connection
     *  @returns N/A
     */
    async handleConnection(client: Socket): Promise<void> {
        Logger.log(`Client connected: ${client.id}`);
    }

    /**
     *  @description activities to be done immediately after connection
     *  @param PostConnectionDto
     *  @returns N/A
     */
    async handlePostConnection(client: Socket) {
        const user = client.data.user as User;

        this.userSocketMap.set(user.id.toString(), client.id);
        this.socketUserMap.set(client.id, user.id.toString());

        return Utils.buildResponse({
            message: "post connection successful",
        });
    }

    emitNotificationToUser(
        userId: number,
        payload: IWsNewNotification,
        server: Server
    ) {
        const socketId = this.userSocketMap.get(userId.toString());
        if (socketId) {
            server.to(socketId).emit(
                "notification",
                Utils.buildResponse({
                    message: "new Notification",
                    data: payload,
                })
            );
        } else {
            Logger.warn(`User ${userId} is not connected`);
        }
    }

    async getNotifications(client: Socket) {
        const user = client.data.user;
        const notifications = await this.prismaService.notification.findMany({
            where: { userId: user.id },
            orderBy: { createdAt: "desc" },
            take: 20,
        });

        return Utils.buildResponse({
            message: "notification list retrieved",
            data: notifications,
        });
    }

    async getUserWallets(client: Socket, query: GetUserAssetsDto) {
        const user = client.data.user;

        return this.userService.getUserWallets(user, query);
    }

    /**
     *  @description handles disconnected sockets
     *  @returns N/A
     */
    handleDisconnect(client: Socket): void {
        Logger.log(`Client disconnected: ${client.id}`);

        const userId = this.socketUserMap.get(client.id);
        if (userId) {
            this.userSocketMap.delete(userId);
            this.socketUserMap.delete(client.id);
        }
    }
}
