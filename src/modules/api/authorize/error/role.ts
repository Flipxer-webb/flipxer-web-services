import { HttpException } from "@nestjs/common";

export class RoleNotFoundException extends HttpException {
    name = "RoleNotFoundException";
}

export class PermissionNotFoundException extends HttpException {
    name: "PermissionNotFoundException";
}
