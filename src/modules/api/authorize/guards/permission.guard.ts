import {
    Injectable,
    CanActivate,
    ExecutionContext,
    HttpStatus,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Permission, Role, RolePermission } from "@prisma/client";
import {
    PermissionNotFoundException,
    RoleNotFoundException,
} from "../error/role";
import { PrismaService } from "@/modules/core/prisma/services";
import { UserNotFoundException } from "../../user";
import { RoleEnum } from "../enums/role";
import { Permissions } from "../decorator";
import { UserWithRoles } from "../../user";

@Injectable()
export class PermissionGuard implements CanActivate {
    constructor(
        private reflector: Reflector,
        private readonly prismaService: PrismaService
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const decoratedPermissions = this.reflector.getAllAndMerge(
            Permissions,
            [context.getHandler(), context.getClass()]
        );
        if (!decoratedPermissions) {
            return true;
        }
        const request = context.switchToHttp().getRequest();
        const user: UserWithRoles = request.user as UserWithRoles;
        if (!user) {
            throw new UserNotFoundException(
                `cannot find authenticated user`,
                HttpStatus.NOT_FOUND
            );
        }
        const userRole: Role = await this.prismaService.role.findUnique({
            where: {
                id: user.roleId,
            },
        });
        if (!userRole) {
            throw new RoleNotFoundException(
                `No role found for user`,
                HttpStatus.FORBIDDEN
            );
        }

        if (userRole.slug === RoleEnum.SUPER_ADMIN) {
            return true;
        }

        const rolePermissions: RolePermission[] =
            await this.prismaService.rolePermission.findMany({
                where: {
                    roleId: userRole.id,
                },
            });
        const permissionIds: number[] = rolePermissions.map(
            (rp: RolePermission) => rp.permissionId
        );
        const userPermissionNames: string[] = (
            await this.prismaService.permission.findMany({
                where: {
                    id: {
                        in: permissionIds,
                    },
                },
            })
        ).map((p: Permission) => p.name);

        const hasPermission: boolean = decoratedPermissions.every((el) =>
            userPermissionNames.includes(el)
        );
        if (!hasPermission) {
            throw new PermissionNotFoundException(
                `You do not have sufficient permission to this resource`,
                HttpStatus.FORBIDDEN
            );
        }
        return true;
    }
}
