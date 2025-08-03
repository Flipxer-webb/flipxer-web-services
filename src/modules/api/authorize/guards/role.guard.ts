import {
    Injectable,
    CanActivate,
    ExecutionContext,
    HttpStatus,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { User, UserType } from "@prisma/client";
import { RoleNotFoundException, WsRoleNotFoundException } from "../error";
import { UserTypes } from "../decorator";
import { Socket } from "socket.io";

@Injectable()
export class RoleGuard implements CanActivate {
    constructor(private reflector: Reflector) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const decoratedRoles: UserType[] = this.reflector.getAllAndOverride(
            UserTypes,
            [context.getHandler(), context.getClass()]
        );
        if (!decoratedRoles) {
            return true;
        }
        const request = context.switchToHttp().getRequest();
        const user: User = request.user as User;
        if (!decoratedRoles.includes(user.userType)) {
            throw new RoleNotFoundException(
                `You are not allowed access to this operation`,
                HttpStatus.FORBIDDEN
            );
        }
        return true;
    }
}

@Injectable()
export class SocketRoleGuard implements CanActivate {
    constructor(private reflector: Reflector) {}

    canActivate(context: ExecutionContext): boolean {
        const decoratedRoles: UserType[] = this.reflector.getAllAndOverride(
            UserTypes,
            [context.getHandler(), context.getClass()]
        );

        if (!decoratedRoles) {
            return true;
        }

        const client: Socket = context.switchToWs().getClient<Socket>();
        const user = client.data.user;

        if (!user || !decoratedRoles.includes(user.userType)) {
            throw new WsRoleNotFoundException(
                `You are not allowed access to this operation`
            );
        }
        return true;
    }
}
