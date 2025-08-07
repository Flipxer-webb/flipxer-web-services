import { WsException } from "@nestjs/websockets";

export class WsAuthTokenValidationException extends WsException {
    name = "WsAuthTokenValidationException";
}

export class WsMissingAuthorizationToken extends WsException {
    name = "WsMissingAuthorizationToken";
}

export class WsUserNotFoundException extends WsException {
    name = "WsUserNotFoundException";
}

export class WsPrismaNetworkException extends WsException {
    name = "WsPrismaNetworkException";
}
