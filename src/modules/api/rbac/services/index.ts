import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { buildResponse, ApiResponse } from "@/utils/api-response-util";
import { buildPaginationMeta, defaultPagination } from "@/utils";
import { Prisma, Role, Permission, UserType } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { generateId } from "@/utils";
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
import {
    RoleAlreadyExistsException,
    RoleNotFoundException,
    CannotDeleteDefaultRoleException,
    PermissionNotFoundException,
    AdminUserAlreadyExistsException,
    AdminUserNotFoundException,
    CannotModifySuperAdminException,
} from "../errors";
import { PermissionNames, RoleTemplates } from "../enums";
import { ADMIN_USER_TYPES } from "../../authorize/decorator";

@Injectable()
export class RbacService {
    private readonly logger = new Logger(RbacService.name);

    constructor(private readonly prisma: PrismaService) {}

    /**
     * Derive the correct UserType enum from a role's slug.
     * "super-admin" → SUPER_ADMIN, all other admin roles → ADMIN.
     */
    private deriveUserType(roleSlug: string): UserType {
        return roleSlug === "super-admin" ? UserType.SUPER_ADMIN : UserType.ADMIN;
    }

    // ==================== ROLES ====================

    async getAllRoles(): Promise<ApiResponse> {
        const roles = await this.prisma.role.findMany({
            where: { isAdmin: true },
            include: {
                rolePermission: {
                    include: { permission: true },
                },
                _count: { select: { users: true } },
            },
            orderBy: { createdAt: "asc" },
        });

        const shapedRoles = roles.map((role) => ({
            id: role.id,
            name: role.name,
            slug: role.slug,
            description: role.description,
            isAdmin: role.isAdmin,
            usersCount: role._count.users,
            permissions: role.rolePermission.map((rp) => ({
                id: rp.permission.id,
                name: rp.permission.name,
                description: rp.permission.description,
                group: rp.permission.group,
            })),
            createdAt: role.createdAt,
        }));

        return buildResponse({
            message: "Roles retrieved successfully",
            data: shapedRoles,
        });
    }

    async getRoleById(roleId: number): Promise<ApiResponse> {
        const role = await this.prisma.role.findUnique({
            where: { id: roleId },
            include: {
                rolePermission: {
                    include: { permission: true },
                },
                _count: { select: { users: true } },
            },
        });

        if (!role) {
            throw new RoleNotFoundException();
        }

        return buildResponse({
            message: "Role retrieved successfully",
            data: {
                id: role.id,
                name: role.name,
                slug: role.slug,
                description: role.description,
                isAdmin: role.isAdmin,
                usersCount: role._count.users,
                permissions: role.rolePermission.map((rp) => ({
                    id: rp.permission.id,
                    name: rp.permission.name,
                    description: rp.permission.description,
                    group: rp.permission.group,
                })),
                createdAt: role.createdAt,
            },
        });
    }

    async createRole(dto: CreateRoleDto, auditContext?: { ipAddress?: string; userAgent?: string }): Promise<ApiResponse> {
        const slug = dto.name.toLowerCase().replace(/\s+/g, "-");

        const existingRole = await this.prisma.role.findFirst({
            where: { OR: [{ name: dto.name }, { slug }] },
        });

        if (existingRole) {
            throw new RoleAlreadyExistsException(
                `Role with name "${dto.name}" already exists`
            );
        }

        // Verify all permissions exist
        const permissions = await this.prisma.permission.findMany({
            where: { id: { in: dto.permissionIds } },
        });

        if (permissions.length !== dto.permissionIds.length) {
            throw new PermissionNotFoundException(
                "One or more permissions not found"
            );
        }

        const role = await this.prisma.role.create({
            data: {
                name: dto.name,
                slug,
                description: dto.description,
                isAdmin: true,
                rolePermission: {
                    create: dto.permissionIds.map((permissionId) => ({
                        permissionId,
                    })),
                },
            },
            include: {
                rolePermission: {
                    include: { permission: true },
                },
            },
        });

        // Log audit trail
        await this.createAuditLog({
            action: "CREATE_ROLE",
            resource: "role",
            resourceId: role.id.toString(),
            details: { roleName: role.name, permissionCount: dto.permissionIds.length },
            ipAddress: auditContext?.ipAddress,
            userAgent: auditContext?.userAgent,
        });

        return buildResponse({
            message: "Role created successfully",
            data: {
                id: role.id,
                name: role.name,
                slug: role.slug,
                description: role.description,
                permissions: role.rolePermission.map((rp) => ({
                    id: rp.permission.id,
                    name: rp.permission.name,
                })),
            },
        });
    }

    async updateRole(roleId: number, dto: UpdateRoleDto, auditContext?: { ipAddress?: string; userAgent?: string }): Promise<ApiResponse> {
        const role = await this.prisma.role.findUnique({
            where: { id: roleId },
        });

        if (!role) {
            throw new RoleNotFoundException();
        }

        // Prevent modifying default super-admin
        if (role.slug === "super-admin") {
            throw new CannotModifySuperAdminException();
        }

        const updateData: Prisma.RoleUpdateInput = {};
        if (dto.name) {
            updateData.name = dto.name;
            updateData.slug = dto.name.toLowerCase().replace(/\s+/g, "-");
        }
        if (dto.description !== undefined) {
            updateData.description = dto.description;
        }

        // Update permissions if provided
        if (dto.permissionIds && dto.permissionIds.length > 0) {
            // Delete existing permissions
            await this.prisma.rolePermission.deleteMany({
                where: { roleId },
            });

            // Add new permissions
            await this.prisma.rolePermission.createMany({
                data: dto.permissionIds.map((permissionId) => ({
                    roleId,
                    permissionId,
                })),
            });
        }

        const updatedRole = await this.prisma.role.update({
            where: { id: roleId },
            data: updateData,
            include: {
                rolePermission: {
                    include: { permission: true },
                },
            },
        });

        await this.createAuditLog({
            action: "UPDATE_ROLE",
            resource: "role",
            resourceId: roleId.toString(),
            details: { changes: dto },
            ipAddress: auditContext?.ipAddress,
            userAgent: auditContext?.userAgent,
        });

        return buildResponse({
            message: "Role updated successfully",
            data: updatedRole,
        });
    }

    async deleteRole(roleId: number, auditContext?: { ipAddress?: string; userAgent?: string }): Promise<ApiResponse> {
        const role = await this.prisma.role.findUnique({
            where: { id: roleId },
            include: { _count: { select: { users: true } } },
        });

        if (!role) {
            throw new RoleNotFoundException();
        }

        // Prevent deleting default roles
        const defaultRoles = ["super-admin", "customer", "business"];
        if (defaultRoles.includes(role.slug)) {
            throw new CannotDeleteDefaultRoleException();
        }

        // Prevent deleting if users are assigned
        if (role._count.users > 0) {
            return buildResponse({
                message: `Cannot delete role. ${role._count.users} users are assigned to this role.`,
                data: null,
            });
        }

        await this.prisma.rolePermission.deleteMany({
            where: { roleId },
        });

        await this.prisma.role.delete({
            where: { id: roleId },
        });

        await this.createAuditLog({
            action: "DELETE_ROLE",
            resource: "role",
            resourceId: roleId.toString(),
            details: { roleName: role.name },
            ipAddress: auditContext?.ipAddress,
            userAgent: auditContext?.userAgent,
        });

        return buildResponse({
            message: "Role deleted successfully",
            data: null,
        });
    }

    async assignPermissionsToRole(
        roleId: number,
        dto: AssignPermissionsDto,
        auditContext?: { ipAddress?: string; userAgent?: string },
    ): Promise<ApiResponse> {
        const role = await this.prisma.role.findUnique({
            where: { id: roleId },
        });

        if (!role) {
            throw new RoleNotFoundException();
        }

        // Verify permissions exist
        const permissions = await this.prisma.permission.findMany({
            where: { id: { in: dto.permissionIds } },
        });

        if (permissions.length !== dto.permissionIds.length) {
            throw new PermissionNotFoundException("One or more permissions not found");
        }

        // Replace all permissions
        await this.prisma.rolePermission.deleteMany({
            where: { roleId },
        });

        await this.prisma.rolePermission.createMany({
            data: dto.permissionIds.map((permissionId) => ({
                roleId,
                permissionId,
            })),
        });

        await this.createAuditLog({
            action: "ASSIGN_PERMISSIONS",
            resource: "role",
            resourceId: roleId.toString(),
            details: { permissionCount: dto.permissionIds.length },
            ipAddress: auditContext?.ipAddress,
            userAgent: auditContext?.userAgent,
        });

        return buildResponse({
            message: "Permissions assigned successfully",
            data: null,
        });
    }

    // ==================== PERMISSIONS ====================

    async getAllPermissions(): Promise<ApiResponse> {
        const permissions = await this.prisma.permission.findMany({
            orderBy: [{ group: "asc" }, { name: "asc" }],
        });

        // Group permissions by group
        const groupedPermissions = permissions.reduce((acc, permission) => {
            const group = permission.group;
            if (!acc[group]) {
                acc[group] = [];
            }
            acc[group].push(permission);
            return acc;
        }, {} as Record<string, typeof permissions>);

        return buildResponse({
            message: "Permissions retrieved successfully",
            data: {
                permissions,
                grouped: groupedPermissions,
            },
        });
    }

    // ==================== ADMIN USERS ====================

    async getAdminUsers(query: GetAdminUsersDto): Promise<ApiResponse> {
        const { pageNumber = 1, pageSize = 20, searchText, roleId } = query;

        const where: Prisma.UserWhereInput = {
            userType: { in: ADMIN_USER_TYPES },
            ...(roleId && { roleId }),
            ...(searchText && {
                OR: [
                    { firstName: { contains: searchText, mode: "insensitive" } },
                    { lastName: { contains: searchText, mode: "insensitive" } },
                    { email: { contains: searchText, mode: "insensitive" } },
                ],
            }),
        };

        const [admins, count] = await this.prisma.$transaction([
            this.prisma.user.findMany({
                where,
                select: {
                    id: true,
                    identifier: true,
                    firstName: true,
                    lastName: true,
                    email: true,
                    phone: true,
                    photo: true,
                    status: true,
                    roleId: true,
                    role: {
                        select: {
                            id: true,
                            name: true,
                            slug: true,
                        },
                    },
                    createdAt: true,
                    lastLogin: true,
                },
                skip: (pageNumber - 1) * pageSize,
                take: pageSize,
                orderBy: { createdAt: "desc" },
            }),
            this.prisma.user.count({ where }),
        ]);

        return buildResponse({
            message: "Admin users retrieved successfully",
            data: {
                meta: buildPaginationMeta(pageNumber, pageSize, count, admins.length),
                records: admins,
            },
        });
    }

    async getAdminUserById(adminId: number): Promise<ApiResponse> {
        const admin = await this.prisma.user.findFirst({
            where: { id: adminId, userType: { in: ADMIN_USER_TYPES } },
            select: {
                id: true,
                identifier: true,
                firstName: true,
                lastName: true,
                email: true,
                phone: true,
                photo: true,
                status: true,
                roleId: true,
                role: {
                    select: {
                        id: true,
                        name: true,
                        slug: true,
                        rolePermission: {
                            select: {
                                permission: {
                                    select: {
                                        id: true,
                                        name: true,
                                        description: true,
                                        group: true,
                                    },
                                },
                            },
                        },
                    },
                },
                createdAt: true,
                lastLogin: true,
                loginCount: true,
            },
        });

        if (!admin) {
            throw new AdminUserNotFoundException();
        }

        return buildResponse({
            message: "Admin user retrieved successfully",
            data: {
                ...admin,
                permissions: admin.role.rolePermission.map((rp) => rp.permission),
            },
        });
    }

    async createAdminUser(dto: CreateAdminUserDto, auditContext?: { ipAddress?: string; userAgent?: string }): Promise<ApiResponse> {
        // Check if email already exists
        const existingUser = await this.prisma.user.findUnique({
            where: { email: dto.email },
        });

        if (existingUser) {
            throw new AdminUserAlreadyExistsException(dto.email);
        }

        // Verify role exists and is admin role
        const role = await this.prisma.role.findUnique({
            where: { id: dto.roleId },
        });

        if (!role || !role.isAdmin) {
            throw new RoleNotFoundException("Admin role not found");
        }

        const hashedPassword = await bcrypt.hash(dto.password, 10);
        const identifier = generateId({ type: "identifier" });

        const admin = await this.prisma.user.create({
            data: {
                identifier,
                firstName: dto.firstName,
                lastName: dto.lastName,
                email: dto.email,
                phone: dto.phone,
                password: hashedPassword,
                userType: this.deriveUserType(role.slug),
                roleId: dto.roleId,
                isEmailVerified: true,
                isPasswordCreated: true,
            },
            select: {
                id: true,
                identifier: true,
                firstName: true,
                lastName: true,
                email: true,
                role: { select: { name: true } },
                createdAt: true,
            },
        });

        await this.createAuditLog({
            action: "CREATE_ADMIN_USER",
            resource: "admin_user",
            resourceId: admin.id.toString(),
            details: { email: admin.email, role: role.name },
            ipAddress: auditContext?.ipAddress,
            userAgent: auditContext?.userAgent,
        });

        return buildResponse({
            message: "Admin user created successfully",
            data: admin,
        });
    }

    async updateAdminUser(
        adminId: number,
        dto: UpdateAdminUserDto,
        auditContext?: { ipAddress?: string; userAgent?: string },
    ): Promise<ApiResponse> {
        const admin = await this.prisma.user.findFirst({
            where: { id: adminId, userType: { in: ADMIN_USER_TYPES } },
            include: { role: true },
        });

        if (!admin) {
            throw new AdminUserNotFoundException();
        }

        // Prevent modifying super admin
        if (admin.role.slug === "super-admin") {
            throw new CannotModifySuperAdminException();
        }

        const updateData: Prisma.UserUpdateInput = {};
        if (dto.firstName) updateData.firstName = dto.firstName;
        if (dto.lastName) updateData.lastName = dto.lastName;
        if (dto.phone) updateData.phone = dto.phone;
        if (dto.roleId) {
            // Sync userType when role changes
            const newRole = await this.prisma.role.findUnique({ where: { id: dto.roleId } });
            if (!newRole || !newRole.isAdmin) {
                throw new RoleNotFoundException("Admin role not found");
            }
            updateData.role = { connect: { id: dto.roleId } };
            updateData.userType = this.deriveUserType(newRole.slug);
        }
        if (dto.isActive !== undefined) {
            updateData.status = dto.isActive ? "ACTIVE" : "BLOCKED";
        }

        const updatedAdmin = await this.prisma.user.update({
            where: { id: adminId },
            data: updateData,
            select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                status: true,
                role: { select: { name: true } },
            },
        });

        await this.createAuditLog({
            action: "UPDATE_ADMIN_USER",
            resource: "admin_user",
            resourceId: adminId.toString(),
            details: { changes: dto },
            ipAddress: auditContext?.ipAddress,
            userAgent: auditContext?.userAgent,
        });

        return buildResponse({
            message: "Admin user updated successfully",
            data: updatedAdmin,
        });
    }

    async deleteAdminUser(adminId: number, auditContext?: { ipAddress?: string; userAgent?: string }): Promise<ApiResponse> {
        const admin = await this.prisma.user.findFirst({
            where: { id: adminId, userType: { in: ADMIN_USER_TYPES } },
            include: { role: true },
        });

        if (!admin) {
            throw new AdminUserNotFoundException();
        }

        if (admin.role.slug === "super-admin") {
            throw new CannotModifySuperAdminException();
        }

        await this.prisma.user.delete({
            where: { id: adminId },
        });

        await this.createAuditLog({
            action: "DELETE_ADMIN_USER",
            resource: "admin_user",
            resourceId: adminId.toString(),
            details: { email: admin.email },
            ipAddress: auditContext?.ipAddress,
            userAgent: auditContext?.userAgent,
        });

        return buildResponse({
            message: "Admin user deleted successfully",
            data: null,
        });
    }

    async changeAdminPassword(
        adminId: number,
        dto: ChangeAdminPasswordDto,
        auditContext?: { ipAddress?: string; userAgent?: string },
    ): Promise<ApiResponse> {
        const admin = await this.prisma.user.findFirst({
            where: { id: adminId, userType: { in: ADMIN_USER_TYPES } },
        });

        if (!admin) {
            throw new AdminUserNotFoundException();
        }

        const hashedPassword = await bcrypt.hash(dto.newPassword, 10);

        await this.prisma.user.update({
            where: { id: adminId },
            data: { password: hashedPassword },
        });

        await this.createAuditLog({
            action: "CHANGE_ADMIN_PASSWORD",
            resource: "admin_user",
            resourceId: adminId.toString(),
            details: {},
            ipAddress: auditContext?.ipAddress,
            userAgent: auditContext?.userAgent,
        });

        return buildResponse({
            message: "Password changed successfully",
            data: null,
        });
    }

    // ==================== AUDIT LOGS ====================

    async getAuditLogs(query: GetAuditLogsDto): Promise<ApiResponse> {
        const { pageNumber = 1, pageSize = 20 } = query;

        const where: Prisma.AuditLogWhereInput = {
            ...(query.adminId && { adminId: query.adminId }),
            ...(query.action && { action: query.action }),
            ...(query.resource && { resource: query.resource }),
            ...(query.startDate || query.endDate
                ? {
                      createdAt: {
                          ...(query.startDate && { gte: new Date(query.startDate) }),
                          ...(query.endDate && { lte: new Date(query.endDate) }),
                      },
                  }
                : {}),
        };

        const [logs, count] = await this.prisma.$transaction([
            this.prisma.auditLog.findMany({
                where,
                include: {
                    admin: {
                        select: {
                            id: true,
                            firstName: true,
                            lastName: true,
                            email: true,
                        },
                    },
                },
                skip: (pageNumber - 1) * pageSize,
                take: pageSize,
                orderBy: { createdAt: "desc" },
            }),
            this.prisma.auditLog.count({ where }),
        ]);

        return buildResponse({
            message: "Audit logs retrieved successfully",
            data: {
                meta: buildPaginationMeta(pageNumber, pageSize, count, logs.length),
                records: logs,
            },
        });
    }

    // ==================== HELPERS ====================

    private async createAuditLog(params: {
        action: string;
        resource: string;
        resourceId: string;
        details: Record<string, any>;
        adminId?: number;
        ipAddress?: string;
        userAgent?: string;
    }): Promise<void> {
        try {
            await this.prisma.auditLog.create({
                data: {
                    action: params.action,
                    resource: params.resource,
                    resourceId: params.resourceId,
                    details: params.details,
                    adminId: params.adminId,
                    ipAddress: params.ipAddress,
                    userAgent: params.userAgent,
                },
            });
        } catch (error) {
            this.logger.error("Failed to create audit log", error);
        }
    }

    // Initialize permissions from enum (for seeding)
    async seedPermissions(): Promise<void> {
        const permissionsList = Object.entries(PermissionNames).map(([key, name]) => {
            const [group] = name.split(".");
            return {
                name,
                description: key.replace(/_/g, " ").toLowerCase(),
                group: group.toUpperCase(),
            };
        });

        for (const perm of permissionsList) {
            await this.prisma.permission.upsert({
                where: { name: perm.name },
                update: {},
                create: {
                    name: perm.name,
                    description: perm.description,
                    group: perm.group as any,
                },
            });
        }

        this.logger.log(`Seeded ${permissionsList.length} permissions`);
    }
}
