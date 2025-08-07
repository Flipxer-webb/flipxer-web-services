import { HttpException } from "@nestjs/common";
import { WsException } from "@nestjs/websockets";

export class RoleNotFoundException extends HttpException {
    name = "RoleNotFoundException";
}

export class PermissionNotFoundException extends HttpException {
    name: "PermissionNotFoundException";
}

export class WsRoleNotFoundException extends WsException {
    name = "WsRoleNotFoundException";
}
