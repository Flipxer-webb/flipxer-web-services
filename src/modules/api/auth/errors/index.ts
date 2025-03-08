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

export class InvalidEmailVerificationCodeException extends HttpException {
    name = "InvalidVerificationCodeException";
}

export class VerificationCodeExpiredException extends HttpException {
    name = "VerificationCodeExpiredException";
}

export class DuplicateBvnVerificationException extends HttpException {
    name = "DuplicateBvnVerificationException";
}
export class DuplicateVerificationException extends HttpException {
    name = "DuplicateVerificationException";
}

export class InvalidVerificationCodeException extends HttpException {
    name = "InvalidVerificationCodeException";
}

export class VerificationGenericException extends HttpException {
    name = "VerificationGenericException";
}
