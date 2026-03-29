import { HttpStatus } from "@nestjs/common";
import {
    AuthGenericException,
    AuthTokenValidationException,
    DuplicateBvnVerificationException,
    DuplicateVerificationException,
    Invalid2FACodeException,
    InvalidAuthTokenException,
    InvalidCredentialException,
    InvalidEmailVerificationCodeException,
    InvalidRefreshToken,
    InvalidResetCodeException,
    InvalidResetRequestException,
    InvalidVerificationCodeException,
    PrismaNetworkException,
    RequiredFilesMissing,
    ResetCodeExpiredException,
    TwoFactorLockedException,
    UserAccountDisabledException,
    UserForbiddenException,
    UserNotFoundException,
    UserUnauthorizedException,
    VerificationCodeExpiredException,
    VerificationGenericException,
} from "../index";

describe("Auth errors", () => {
    it("builds auth exceptions with expected names and statuses", () => {
        const unauthorized = new UserUnauthorizedException();
        expect(unauthorized.name).toBe("UserUnauthorizedException");
        expect(unauthorized.getStatus()).toBe(HttpStatus.UNAUTHORIZED);

        const forbidden = new UserForbiddenException("Forbidden", HttpStatus.FORBIDDEN);
        expect(forbidden.name).toBe("UserForbiddenException");
        expect(forbidden.getStatus()).toBe(HttpStatus.FORBIDDEN);

        const invalidToken = new InvalidAuthTokenException();
        expect(invalidToken.name).toBe("InvalidAuthTokenException");
        expect(invalidToken.getStatus()).toBe(HttpStatus.UNAUTHORIZED);

        const validation = new AuthTokenValidationException();
        expect(validation.name).toBe("AuthTokenValidationException");
        expect(validation.getStatus()).toBe(HttpStatus.BAD_REQUEST);

        const creds = new InvalidCredentialException();
        expect(creds.name).toBe("InvalidCredentialException");
        expect(creds.getStatus()).toBe(HttpStatus.BAD_REQUEST);

        const network = new PrismaNetworkException();
        expect(network.name).toBe("PrismaNetworkException");
        expect(network.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);

        const authGeneric = new AuthGenericException();
        expect(authGeneric.name).toBe("AuthGenericException");
        expect(authGeneric.getStatus()).toBe(HttpStatus.BAD_REQUEST);

        const disabled = new UserAccountDisabledException();
        expect(disabled.name).toBe("UserAccountDisabledException");
        expect(disabled.getStatus()).toBe(HttpStatus.FORBIDDEN);

        const userNotFound = new UserNotFoundException();
        expect(userNotFound.name).toBe("UserNotFoundException");
        expect(userNotFound.getStatus()).toBe(HttpStatus.NOT_FOUND);

        const refresh = new InvalidRefreshToken("invalid", HttpStatus.UNAUTHORIZED);
        expect(refresh.name).toBe("InvalidRefreshToken");
        expect(refresh.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    });

    it("builds verification and reset exceptions", () => {
        const invalidEmailCode = new InvalidEmailVerificationCodeException();
        expect(invalidEmailCode.name).toBe("InvalidVerificationCodeException");

        const codeExpired = new VerificationCodeExpiredException();
        expect(codeExpired.name).toBe("VerificationCodeExpiredException");

        const duplicateBvn = new DuplicateBvnVerificationException();
        expect(duplicateBvn.name).toBe("DuplicateBvnVerificationException");

        const duplicate = new DuplicateVerificationException();
        expect(duplicate.name).toBe("DuplicateVerificationException");

        const invalidCode = new InvalidVerificationCodeException();
        expect(invalidCode.name).toBe("InvalidVerificationCodeException");

        const verificationGeneric = new VerificationGenericException();
        expect(verificationGeneric.name).toBe("VerificationGenericException");

        const resetCode = new InvalidResetCodeException();
        expect(resetCode.name).toBe("InvalidResetCodeException");

        const resetExpired = new ResetCodeExpiredException();
        expect(resetExpired.name).toBe("ResetCodeExpiredException");

        const invalidResetRequest = new InvalidResetRequestException();
        expect(invalidResetRequest.name).toBe("InvalidResetRequestException");

        const requiredFiles = new RequiredFilesMissing();
        expect(requiredFiles.name).toBe("RequiredFilesMissing");
    });

    it("encodes structured 2FA errors", () => {
        const invalid2fa = new Invalid2FACodeException();
        expect(invalid2fa.name).toBe("Invalid2FACodeException");
        expect(invalid2fa.getStatus()).toBe(HttpStatus.BAD_REQUEST);
        expect(invalid2fa.getResponse()).toEqual({
            message: "Invalid verification code",
            code: "INVALID_2FA_CODE",
        });

        const lockedWithDuration = new TwoFactorLockedException("Too many failed 2FA attempts", 60);
        expect(lockedWithDuration.name).toBe("TwoFactorLockedException");
        expect(lockedWithDuration.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
        expect(lockedWithDuration.getResponse()).toEqual({
            message: "Too many failed 2FA attempts. Account locked for 60 seconds.",
            code: "TWO_FACTOR_LOCKED",
        });

        const lockedNoDuration = new TwoFactorLockedException();
        expect(lockedNoDuration.getResponse()).toEqual({
            message: "Too many failed 2FA attempts",
            code: "TWO_FACTOR_LOCKED",
        });
    });
});
