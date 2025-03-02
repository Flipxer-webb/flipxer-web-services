import { HttpException } from "@nestjs/common";

export class UserUnauthorizedException extends HttpException {
    name = "UserUnauthorizedException";
}

export class InvalidAuthTokenException extends HttpException {
    name = "InvalidAuthTokenException";
}

export class AuthTokenValidationException extends HttpException {
    name = "AuthTokenValidationException";
}

export class InvalidCredentialException extends HttpException {
    name = "InvalidCredentialException";
}

export class PrismaNetworkException extends HttpException {
    name = "PrismaNetworkException";
}

export class AuthGenericException extends HttpException {
    name = "AuthGenericException";
}

export class UserAccountDisabledException extends HttpException {
    name = "UserAccountDisabledException";
}
