import {
    Controller,
    Get,
    Post,
    Put,
    Delete,
    Body,
    Param,
    Query,
    ParseIntPipe,
    UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AuthGuard, EnabledAccountGuard } from "@/modules/api/auth/guard";
import { UserTypes } from "@/modules/api/authorize/decorator";
import { UserType } from "@prisma/client";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { PermissionGuard } from "@/modules/api/authorize/guards/permission.guard";
import { Permissions } from "@/modules/api/authorize/decorator";
import { PermissionName } from "@/modules/api/authorize/enums/role";
import { RbacService } from "../services";
import {
    CreateRoleDto,
    UpdateRoleDto,
    CreateAdminUserDto,
    UpdateAdminUserDto,
    GetAdminUsersDto,
    ChangeAdminPasswordDto,
    AssignPermissionsDto,
    GetAuditLogsDto,
} from "../dtos";

@UseGuards(AuthGuard, RoleGuard, EnabledAccountGuard, PermissionGuard)
@UserTypes([UserType.ADMIN])
@ApiTags("admin/rbac")
@Controller({ path: "admin/rbac" })
export class RbacController {
    constructor(private readonly rbacService: RbacService) {}

    // ==================== ROLES ====================

    @ApiOperation({ summary: "Get all admin roles" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.ROLES_READ])
    @Get("roles")
    async getAllRoles() {
        return await this.rbacService.getAllRoles();
    }

    @ApiOperation({ summary: "Get role by ID" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.ROLES_READ])
    @Get("roles/:roleId")
    async getRoleById(@Param("roleId", ParseIntPipe) roleId: number) {
        return await this.rbacService.getRoleById(roleId);
    }

    @ApiOperation({ summary: "Create a new role" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.ROLES_CREATE])
    @Post("roles")
    async createRole(@Body() dto: CreateRoleDto) {
        return await this.rbacService.createRole(dto);
    }

    @ApiOperation({ summary: "Update a role" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.ROLES_UPDATE])
    @Put("roles/:roleId")
    async updateRole(
        @Param("roleId", ParseIntPipe) roleId: number,
        @Body() dto: UpdateRoleDto
    ) {
        return await this.rbacService.updateRole(roleId, dto);
    }

    @ApiOperation({ summary: "Delete a role" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.ROLES_DELETE])
    @Delete("roles/:roleId")
    async deleteRole(@Param("roleId", ParseIntPipe) roleId: number) {
        return await this.rbacService.deleteRole(roleId);
    }

    @ApiOperation({ summary: "Assign permissions to a role" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.PERMISSIONS_MANAGE])
    @Post("roles/:roleId/permissions")
    async assignPermissions(
        @Param("roleId", ParseIntPipe) roleId: number,
        @Body() dto: AssignPermissionsDto
    ) {
        return await this.rbacService.assignPermissionsToRole(roleId, dto);
    }

    // ==================== PERMISSIONS ====================

    @ApiOperation({ summary: "Get all permissions" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.ROLES_READ])
    @Get("permissions")
    async getAllPermissions() {
        return await this.rbacService.getAllPermissions();
    }

    @ApiOperation({ summary: "Seed permissions from defined constants (requires seed key)" })
    @Post("permissions/seed")
    async seedPermissions(@Body() body: { seedKey?: string }) {
        // Simple protection: require a seed key from environment
        const expectedKey = process.env.SEED_KEY || "flipxer-seed-2024";
        if (body.seedKey !== expectedKey) {
            return { success: false, message: "Invalid seed key" };
        }
        await this.rbacService.seedPermissions();
        return await this.rbacService.getAllPermissions();
    }

    // ==================== ADMIN USERS ====================

    @ApiOperation({ summary: "Get all admin users" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.ROLES_READ])
    @Get("admins")
    async getAdminUsers(@Query() query: GetAdminUsersDto) {
        return await this.rbacService.getAdminUsers(query);
    }

    @ApiOperation({ summary: "Get admin user by ID" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.ROLES_READ])
    @Get("admins/:adminId")
    async getAdminUserById(@Param("adminId", ParseIntPipe) adminId: number) {
        return await this.rbacService.getAdminUserById(adminId);
    }

    @ApiOperation({ summary: "Create a new admin user" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.ROLES_CREATE])
    @Post("admins")
    async createAdminUser(@Body() dto: CreateAdminUserDto) {
        return await this.rbacService.createAdminUser(dto);
    }

    @ApiOperation({ summary: "Update an admin user" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.ROLES_UPDATE])
    @Put("admins/:adminId")
    async updateAdminUser(
        @Param("adminId", ParseIntPipe) adminId: number,
        @Body() dto: UpdateAdminUserDto
    ) {
        return await this.rbacService.updateAdminUser(adminId, dto);
    }

    @ApiOperation({ summary: "Delete an admin user" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.ROLES_DELETE])
    @Delete("admins/:adminId")
    async deleteAdminUser(@Param("adminId", ParseIntPipe) adminId: number) {
        return await this.rbacService.deleteAdminUser(adminId);
    }

    @ApiOperation({ summary: "Change admin user password" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.ROLES_UPDATE])
    @Post("admins/:adminId/change-password")
    async changeAdminPassword(
        @Param("adminId", ParseIntPipe) adminId: number,
        @Body() dto: ChangeAdminPasswordDto
    ) {
        return await this.rbacService.changeAdminPassword(adminId, dto);
    }

    // ==================== AUDIT LOGS ====================

    @ApiOperation({ summary: "Get audit logs" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.SYSTEM_AUDIT_LOGS])
    @Get("audit-logs")
    async getAuditLogs(@Query() query: GetAuditLogsDto) {
        return await this.rbacService.getAuditLogs(query);
    }
}
