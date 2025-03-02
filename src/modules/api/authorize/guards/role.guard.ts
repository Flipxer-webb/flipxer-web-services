import {
    Injectable,
    CanActivate,
    ExecutionContext,
    HttpStatus,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { User, UserType } from "@prisma/client";
import { RoleNotFoundException } from "../error";
import { UserTypes } from "../decorator";

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
