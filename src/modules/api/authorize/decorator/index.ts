import { Reflector } from "@nestjs/core";
import { UserType } from "@prisma/client";
import { PermissionName } from "../enums/role";

export const Permissions = Reflector.createDecorator<PermissionName[]>();
export const UserTypes = Reflector.createDecorator<UserType[]>();

/** Whitelist of UserTypes allowed to access the admin portal. Update this when adding new admin roles. */
export const ADMIN_USER_TYPES: UserType[] = [UserType.ADMIN, UserType.SUPER_ADMIN];
