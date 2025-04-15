// src/modules/auth/errors.ts
import { HttpException, HttpStatus } from "@nestjs/common";

export class UserUnauthorizedException extends HttpException {
    name = "UserUnauthorizedException";
    constructor(message: string = "User is not authorized", status: HttpStatus = HttpStatus.UNAUTHORIZED) {
        super(message, status);
    }
}

export class InvalidAuthTokenException extends HttpException {
    name = "InvalidAuthTokenException";
    constructor(message: string = "Invalid authentication token", status: HttpStatus = HttpStatus.UNAUTHORIZED) {
        super(message, status);
    }
}

export class AuthTokenValidationException extends HttpException {
    name = "AuthTokenValidationException";
    constructor(message: string = "Token validation failed", status: HttpStatus = HttpStatus.BAD_REQUEST) {
        super(message, status);
    }
}

export class InvalidCredentialException extends HttpException {
    name = "InvalidCredentialException";
    constructor(message: string = "Invalid credentials provided", status: HttpStatus = HttpStatus.BAD_REQUEST) {
        super(message, status);
    }
}

export class PrismaNetworkException extends HttpException {
    name = "PrismaNetworkException";
    constructor(message: string = "Database network error", status: HttpStatus = HttpStatus.INTERNAL_SERVER_ERROR) {
        super(message, status);
    }
}

export class AuthGenericException extends HttpException {
    name = "AuthGenericException";
    constructor(message: string = "Authentication error", status: HttpStatus = HttpStatus.BAD_REQUEST) {
        super(message, status);
    }
}

export class UserAccountDisabledException extends HttpException {
    name = "UserAccountDisabledException";
    constructor(message: string = "User account is disabled", status: HttpStatus = HttpStatus.FORBIDDEN) {
        super(message, status);
    }
}

export class InvalidEmailVerificationCodeException extends HttpException {
    name = "InvalidVerificationCodeException";
    constructor(message: string = "Invalid email verification code", status: HttpStatus = HttpStatus.BAD_REQUEST) {
        super(message, status);
    }
}

export class VerificationCodeExpiredException extends HttpException {
    name = "VerificationCodeExpiredException";
    constructor(message: string = "Verification code has expired", status: HttpStatus = HttpStatus.BAD_REQUEST) {
        super(message, status);
    }
}

export class DuplicateBvnVerificationException extends HttpException {
    name = "DuplicateBvnVerificationException";
    constructor(message: string = "BVN verification already completed", status: HttpStatus = HttpStatus.BAD_REQUEST) {
        super(message, status);
    }
}

export class DuplicateVerificationException extends HttpException {
    name = "DuplicateVerificationException";
    constructor(message: string = "Verification already completed", status: HttpStatus = HttpStatus.BAD_REQUEST) {
        super(message, status);
    }
}

export class InvalidVerificationCodeException extends HttpException {
    name = "InvalidVerificationCodeException";
    constructor(message: string = "Invalid verification code", status: HttpStatus = HttpStatus.BAD_REQUEST) {
        super(message, status);
    }
}

export class VerificationGenericException extends HttpException {
    name = "VerificationGenericException";
    constructor(message: string = "Verification error", status: HttpStatus = HttpStatus.BAD_REQUEST) {
        super(message, status);
    }
}

export class UserNotFoundException extends HttpException {
    name = "UserNotFoundException";
    constructor(message: string = "User not found", status: HttpStatus = HttpStatus.NOT_FOUND) {
        super(message, status);
    }
}

export class InvalidResetCodeException extends HttpException {
    name = "InvalidResetCodeException";
    constructor(message: string = "Invalid reset code", status: HttpStatus = HttpStatus.BAD_REQUEST) {
        super(message, status);
    }
}

export class ResetCodeExpiredException extends HttpException {
    name = "ResetCodeExpiredException";
    constructor(message: string = "Reset code has expired", status: HttpStatus = HttpStatus.BAD_REQUEST) {
        super(message, status);
    }
}

export class InvalidResetRequestException extends HttpException {
    name = "InvalidResetRequestException";
    constructor(message: string = "Invalid password reset request", status: HttpStatus = HttpStatus.BAD_REQUEST) {
        super(message, status);
    }
}