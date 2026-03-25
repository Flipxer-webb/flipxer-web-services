import { Controller, UseGuards } from "@nestjs/common";
import { AuthGuard } from "@/modules/api/auth/guard";
import { RoleGuard } from "../../guards/role.guard";
import AuthorizationService from "../../services/authorize.service";
import { UserType } from "@prisma/client";
import { UserTypes, ADMIN_USER_TYPES } from "../../decorator";

@Controller({
    path: "authz",
})
@UseGuards(AuthGuard, RoleGuard)
@UserTypes(ADMIN_USER_TYPES)
export default class AuthorizationController {
    constructor(private readonly authorizationService: AuthorizationService) {}
}
