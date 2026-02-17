import { forwardRef, Injectable, Logger } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import * as Utils from "@/utils";
import { Socket } from "socket.io";

import { User, UserType } from "@prisma/client";
import { Server } from "socket.io";
import { IWsNewNotification, IWsTransactionUpdate } from "../interfaces/trade";
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
        client.join(`user:${user.id}`);

        if (user.userType === UserType.ADMIN) {
            client.join("admin");
        }

        return Utils.buildResponse({
            message: "post connection successful",
        });
    }

    emitToAdmins(event: string, payload: any, server: Server): void {
        server.to("admin").emit(event, payload);
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

    emitTransactionUpdateToUser(
        userId: number,
        payload: IWsTransactionUpdate,
        server: Server
    ) {
        const socketId = this.userSocketMap.get(userId.toString());
        if (socketId) {
            server.to(socketId).emit(
                "transactionUpdate",
                Utils.buildResponse({
                    message: "transaction updated",
                    data: payload,
                })
            );
            Logger.log(`Transaction update sent to user ${userId}`);
        } else {
            Logger.warn(`User ${userId} is not connected for transaction update`);
        }
    }

    async emitWalletUpdateToUser(userId: number, server: Server) {
        const socketId = this.userSocketMap.get(userId.toString());
        if (socketId) {
            try {
                const walletData = await this.userService.getUserWallets(
                    userId,
                    {} as GetUserAssetsDto
                );
                
                server.to(socketId).emit(
                    "walletAssetsUpdate",
                    Utils.buildResponse({
                        message: "wallet assets update",
                        data: walletData.data,
                    })
                );
                Logger.log(`Wallet update sent to user ${userId}`);
            } catch (err) {
                Logger.error(`Error sending wallet update to user ${userId}`, err);
            }
        } else {
            Logger.warn(`User ${userId} is not connected for wallet update`);
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

        return this.userService.getUserWallets(user.id, query);
    }

    async broadcastWalletUpdates(server: Server) {
        if (!server) return;

        const results = await Promise.allSettled(
            [...this.userSocketMap.entries()].map(
                async ([userId, socketId]) => {
                    try {
                        if (!userId) return;

                        const walletData =
                            await this.userService.getUserWallets(
                                parseInt(userId),
                                {} as GetUserAssetsDto
                            );

                        server.to(socketId).emit(
                            "walletAssetsUpdate",
                            Utils.buildResponse({
                                message: "wallet assets update",
                                data: walletData.data,
                            })
                        );
                    } catch (err) {
                        Logger.error(
                            `Error updating wallet for user ${userId}`,
                            err
                        );
                        // Return rejected manually to log it below
                        //throw new Error(`User ${userId} broadcast failed`);
                    }
                }
            )
        );

        const failed = results.filter((r) => r.status === "rejected");
        if (failed.length) {
            Logger.warn(`${failed.length} user broadcasts failed`);
        }
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
