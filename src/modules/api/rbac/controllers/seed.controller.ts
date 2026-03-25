import { Controller, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AuthGuard, EnabledAccountGuard } from "@/modules/api/auth/guard";
import { UserTypes } from "@/modules/api/authorize/decorator";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { PermissionGuard } from "@/modules/api/authorize/guards/permission.guard";
import { UserType } from "@prisma/client";
import { RbacService } from "../services";

@UseGuards(AuthGuard, RoleGuard, EnabledAccountGuard, PermissionGuard)
@UserTypes([UserType.SUPER_ADMIN])
@ApiTags("admin/rbac/seed")
@Controller({ path: "admin/rbac" })
export class RbacSeedController {
    constructor(private readonly rbacService: RbacService) {}

    @ApiOperation({ summary: "Seed permissions from defined constants (requires SUPER_ADMIN)" })
    @ApiBearerAuth("access-token")
    @Post("permissions/seed")
    async seedPermissions() {
        await this.rbacService.seedPermissions();
        return await this.rbacService.getAllPermissions();
    }
}
