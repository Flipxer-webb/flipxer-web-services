import { PrismaService } from "@/modules/core/prisma/services";
import { Injectable, UseGuards } from "@nestjs/common";

import { AuthGuard } from "../../auth/guard";
import { RoleGuard } from "../guards/role.guard";
import { UserTypes, ADMIN_USER_TYPES } from "../decorator";

@Injectable()
@UseGuards(AuthGuard, RoleGuard)
@UserTypes(ADMIN_USER_TYPES)
export default class AuthorizationService {
    constructor(private readonly prismaService: PrismaService) {}
}
