import { PrismaService } from "@/modules/core/prisma/services";
import { Injectable, UseGuards } from "@nestjs/common";
import { UserType } from "@prisma/client";

import { AuthGuard } from "../../auth/guard";
import { RoleGuard } from "../guards/role.guard";
import { UserTypes } from "../decorator";

@Injectable()
@UseGuards(AuthGuard, RoleGuard)
@UserTypes([UserType.ADMIN, UserType.SUPER_ADMIN])
export default class AuthorizationService {
    constructor(private readonly prismaService: PrismaService) {}
}
