// src/modules/auth/errors.ts
import { HttpException, HttpExceptionOptions, HttpStatus } from "@nestjs/common";

export class UserUnauthorizedException extends HttpException {
    name = "UserUnauthorizedException";
    constructor(
        message = "User is not authorized",
        status: HttpStatus = HttpStatus.UNAUTHORIZED
    ) {
        super(message, status);
    }
}

export class UserForbiddenException extends HttpException {
    name = "UserForbiddenException";
}

export class InvalidAuthTokenException extends HttpException {
    name = "InvalidAuthTokenException";
    constructor(
        message = "Invalid authentication token",
        status: HttpStatus = HttpStatus.UNAUTHORIZED
    ) {
        super(message, status);
    }
}

export class AuthTokenValidationException extends HttpException {
    name = "AuthTokenValidationException";
    constructor(
        message = "Token validation failed",
        status: HttpStatus = HttpStatus.BAD_REQUEST
    ) {
        super(message, status);
    }
}

export class InvalidCredentialException extends HttpException {
    name = "InvalidCredentialException";
    constructor(
        message = "Invalid credentials provided",
        status: HttpStatus = HttpStatus.BAD_REQUEST
    ) {
        super(message, status);
    }
}

// 2FA-specific exceptions with structured error codes
export class Invalid2FACodeException extends HttpException {
    name = "Invalid2FACodeException";
    constructor(
        message = "Invalid verification code",
        status: HttpStatus = HttpStatus.BAD_REQUEST
    ) {
        super({ message, code: "INVALID_2FA_CODE" }, status);
    }
}

export class TwoFactorLockedException extends HttpException {
    name = "TwoFactorLockedException";
    constructor(
        message = "Too many failed 2FA attempts",
        lockoutDuration?: number,
        status: HttpStatus = HttpStatus.TOO_MANY_REQUESTS
    ) {
        const fullMessage = lockoutDuration
            ? `${message}. Account locked for ${lockoutDuration} seconds.`
            : message;
        super({ message: fullMessage, code: "TWO_FACTOR_LOCKED" }, status);
    }
}


export class PrismaNetworkException extends HttpException {
    name = "PrismaNetworkException";
    constructor(
        message = "Database network error",
        status: HttpStatus = HttpStatus.INTERNAL_SERVER_ERROR
    ) {
        super(message, status);
    }
}

export class AuthGenericException extends HttpException {
    name = "AuthGenericException";
    constructor(
        message = "Authentication error",
        status: HttpStatus = HttpStatus.BAD_REQUEST,
        options?: HttpExceptionOptions
    ) {
        super(message, status, options);
    }
}

export class UserAccountDisabledException extends HttpException {
    name = "UserAccountDisabledException";
    constructor(
        message = "User account is disabled",
        status: HttpStatus = HttpStatus.FORBIDDEN
    ) {
        super(message, status);
    }
}

export class InvalidEmailVerificationCodeException extends HttpException {
    name = "InvalidVerificationCodeException";
    constructor(
        message = "Invalid email verification code",
        status: HttpStatus = HttpStatus.BAD_REQUEST
    ) {
        super(message, status);
    }
}

export class VerificationCodeExpiredException extends HttpException {
    name = "VerificationCodeExpiredException";
    constructor(
        message = "Verification code has expired",
        status: HttpStatus = HttpStatus.BAD_REQUEST
    ) {
        super(message, status);
    }
}

export class DuplicateBvnVerificationException extends HttpException {
    name = "DuplicateBvnVerificationException";
    constructor(
        message = "BVN verification already completed",
        status: HttpStatus = HttpStatus.BAD_REQUEST
    ) {
        super(message, status);
    }
}

export class DuplicateVerificationException extends HttpException {
    name = "DuplicateVerificationException";
    constructor(
        message = "Verification already completed",
        status: HttpStatus = HttpStatus.BAD_REQUEST
    ) {
        super(message, status);
    }
}

export class InvalidVerificationCodeException extends HttpException {
    name = "InvalidVerificationCodeException";
    constructor(
        message = "Invalid verification code",
        status: HttpStatus = HttpStatus.BAD_REQUEST
    ) {
        super(message, status);
    }
}

export class VerificationGenericException extends HttpException {
    name = "VerificationGenericException";
    constructor(
        message = "Verification error",
        status: HttpStatus = HttpStatus.BAD_REQUEST
    ) {
        super(message, status);
    }
}

export class UserNotFoundException extends HttpException {
    name = "UserNotFoundException";
    constructor(
        message = "User not found",
        status: HttpStatus = HttpStatus.NOT_FOUND
    ) {
        super(message, status);
    }
}

export class InvalidResetCodeException extends HttpException {
    name = "InvalidResetCodeException";
    constructor(
        message = "Invalid reset code",
        status: HttpStatus = HttpStatus.BAD_REQUEST
    ) {
        super(message, status);
    }
}

export class ResetCodeExpiredException extends HttpException {
    name = "ResetCodeExpiredException";
    constructor(
        message = "Reset code has expired",
        status: HttpStatus = HttpStatus.BAD_REQUEST
    ) {
        super(message, status);
    }
}

export class InvalidResetRequestException extends HttpException {
    name = "InvalidResetRequestException";
    constructor(
        message = "Invalid password reset request",
        status: HttpStatus = HttpStatus.BAD_REQUEST
    ) {
        super(message, status);
    }
}

export class InvalidAdminInviteException extends HttpException {
    name = "InvalidAdminInviteException";
    constructor(
        message = "Invalid admin invite",
        status: HttpStatus = HttpStatus.BAD_REQUEST
    ) {
        super(message, status);
    }
}

export class AdminInviteExpiredException extends HttpException {
    name = "AdminInviteExpiredException";
    constructor(
        message = "Admin invite has expired",
        status: HttpStatus = HttpStatus.BAD_REQUEST
    ) {
        super(message, status);
    }
}

export class InvalidRefreshToken extends HttpException {
    name = "InvalidRefreshToken";
}

export class RequiredFilesMissing extends HttpException {
    name = "RequiredFilesMissing";
    constructor(
        message = "Required file(s) missing",
        status: HttpStatus = HttpStatus.BAD_REQUEST
    ) {
        super(message, status);
    }
}
