import { Reflector } from "@nestjs/core";
import { UserType } from "@prisma/client";
import { PermissionName } from "../enums/role";

export const Permissions = Reflector.createDecorator<PermissionName[]>();
export const UserTypes = Reflector.createDecorator<UserType[]>();
