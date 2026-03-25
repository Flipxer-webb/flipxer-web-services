import {
    Controller,
    Get,
    Post,
    Put,
    Delete,
    Body,
    Param,
    Query,
    Req,
    ParseIntPipe,
    UseGuards,
} from "@nestjs/common";
import { Request } from "express";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AuthGuard, EnabledAccountGuard } from "@/modules/api/auth/guard";
import { UserTypes, ADMIN_USER_TYPES } from "@/modules/api/authorize/decorator";
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
@UserTypes(ADMIN_USER_TYPES)
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
    async createRole(@Body() dto: CreateRoleDto, @Req() req: Request) {
        return await this.rbacService.createRole(dto, { ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    }

    @ApiOperation({ summary: "Update a role" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.ROLES_UPDATE])
    @Put("roles/:roleId")
    async updateRole(
        @Param("roleId", ParseIntPipe) roleId: number,
        @Body() dto: UpdateRoleDto,
        @Req() req: Request,
    ) {
        return await this.rbacService.updateRole(roleId, dto, { ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    }

    @ApiOperation({ summary: "Delete a role" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.ROLES_DELETE])
    @Delete("roles/:roleId")
    async deleteRole(@Param("roleId", ParseIntPipe) roleId: number, @Req() req: Request) {
        return await this.rbacService.deleteRole(roleId, { ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    }

    @ApiOperation({ summary: "Assign permissions to a role" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.PERMISSIONS_MANAGE])
    @Post("roles/:roleId/permissions")
    async assignPermissions(
        @Param("roleId", ParseIntPipe) roleId: number,
        @Body() dto: AssignPermissionsDto,
        @Req() req: Request,
    ) {
        return await this.rbacService.assignPermissionsToRole(roleId, dto, { ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    }

    // ==================== PERMISSIONS ====================

    @ApiOperation({ summary: "Get all permissions" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.ROLES_READ])
    @Get("permissions")
    async getAllPermissions() {
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
    async createAdminUser(@Body() dto: CreateAdminUserDto, @Req() req: Request) {
        return await this.rbacService.createAdminUser(dto, { ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    }

    @ApiOperation({ summary: "Update an admin user" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.ROLES_UPDATE])
    @Put("admins/:adminId")
    async updateAdminUser(
        @Param("adminId", ParseIntPipe) adminId: number,
        @Body() dto: UpdateAdminUserDto,
        @Req() req: Request,
    ) {
        return await this.rbacService.updateAdminUser(adminId, dto, { ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    }

    @ApiOperation({ summary: "Delete an admin user" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.ROLES_DELETE])
    @Delete("admins/:adminId")
    async deleteAdminUser(@Param("adminId", ParseIntPipe) adminId: number, @Req() req: Request) {
        return await this.rbacService.deleteAdminUser(adminId, { ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    }

    @ApiOperation({ summary: "Change admin user password" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.ROLES_UPDATE])
    @Post("admins/:adminId/change-password")
    async changeAdminPassword(
        @Param("adminId", ParseIntPipe) adminId: number,
        @Body() dto: ChangeAdminPasswordDto,
        @Req() req: Request,
    ) {
        return await this.rbacService.changeAdminPassword(adminId, dto, { ipAddress: req.ip, userAgent: req.headers["user-agent"] });
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
