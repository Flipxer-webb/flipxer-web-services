import { DocumentType } from "@prisma/client";

jest.mock("@/modules/api/auth/services", () => ({
    AuthService: class AuthService {},
    __esModule: true,
}));

jest.mock("@/modules/api/auth/services/tier-verification.service", () => ({
    TierVerificationService: class TierVerificationService {},
    __esModule: true,
}));

jest.mock("@/modules/api/auth/guard", () => ({
    AuthGuard: class AuthGuard {},
    CountryBlockGuard: class CountryBlockGuard {},
    EnabledAccountGuard: class EnabledAccountGuard {},
    SocketAuthGuard: class SocketAuthGuard {},
    __esModule: true,
}));

jest.mock("@/modules/api/user", () => ({
    User: () => () => undefined,
    ClientData: () => () => undefined,
    UserModule: class UserModule {},
    AccountDeletedException: class AccountDeletedException extends Error {},
    UserNotFoundException: class UserNotFoundException extends Error {},
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/guards/role.guard", () => ({
    RoleGuard: class RoleGuard {},
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/decorator", () => ({
    UserTypes: () => () => undefined,
    ADMIN_USER_TYPES: ["SUPER_ADMIN"],
    __esModule: true,
}));

jest.mock("@/modules/core/rate-limit/guards/rate-limiter.guard", () => ({
    RateLimiterGuard: class RateLimiterGuard {},
    StrictRateLimit: () => () => undefined,
    RateLimit: () => () => undefined,
    __esModule: true,
}));

import { RequiredFilesMissing } from "../../../errors";
import { AuthController } from "../index";

describe("AuthController", () => {
    let controller: AuthController;

    let authService: Record<string, jest.Mock>;
    let tierVerificationService: Record<string, jest.Mock>;

    const user = { id: 77 } as any;

    beforeEach(() => {
        authService = {
            signUp: jest.fn(),
            userSignIn: jest.fn(),
            verify2FALogin: jest.fn(),
            sendAccountVerificationEmail: jest.fn(),
            verifyEmailOtp: jest.fn(),
            createPassword: jest.fn(),
            onboardIndividual: jest.fn(),
            bvnVerification: jest.fn(),
            ninVerification: jest.fn(),
            sendPhoneVerificationOtp: jest.fn(),
            verifyPhoneOtp: jest.fn(),
            documentVerification: jest.fn(),
            documentVerificationBase64: jest.fn(),
            previewDocument: jest.fn(),
            submitDojahWidgetVerification: jest.fn(),
            submitBusinessRecord: jest.fn(),
            updloadBusinessDocuments: jest.fn(),
            uploadSingleBusinessDocumentFile: jest.fn(),
            submitBusinessDocumentsFromUrls: jest.fn(),
            requestPasswordReset: jest.fn(),
            resetPassword: jest.fn(),
            refreshToken: jest.fn(),
        };

        tierVerificationService = {
            verifyAddress: jest.fn(),
            verifyIncome: jest.fn(),
            createTradingPassword: jest.fn(),
            hasTradingPassword: jest.fn(),
            getVerificationStatus: jest.fn(),
        };

        controller = new AuthController(authService as never, tierVerificationService as never);
        jest.spyOn((controller as any).logger, "debug").mockImplementation(() => undefined);
        jest.spyOn((controller as any).logger, "log").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("masks sensitive ids", () => {
        expect((controller as any).maskSensitiveId(undefined)).toBe("N/A");
        expect((controller as any).maskSensitiveId("1234")).toBe("1234");
        expect((controller as any).maskSensitiveId("1234567890")).toBe("******7890");
    });

    it("delegates auth onboarding and OTP flows", async () => {
        authService.signUp.mockResolvedValue({ ok: 1 });
        authService.userSignIn.mockResolvedValue({ ok: 2 });
        authService.verify2FALogin.mockResolvedValue({ ok: 3 });
        authService.sendAccountVerificationEmail.mockResolvedValue({ ok: 4 });
        authService.verifyEmailOtp.mockResolvedValue({ ok: 5 });
        authService.createPassword.mockResolvedValue({ ok: 6 });
        authService.onboardIndividual.mockResolvedValue({ ok: 7 });
        authService.bvnVerification.mockResolvedValue({ ok: 8 });
        authService.ninVerification.mockResolvedValue({ ok: 9 });
        authService.sendPhoneVerificationOtp.mockResolvedValue({ ok: 10 });
        authService.verifyPhoneOtp.mockResolvedValue({ ok: 11 });

        await expect(controller.signUp({} as never, { ip: "1.2.3.4" } as never)).resolves.toEqual({ ok: 1 });
        await expect(controller.signIn({} as never, { ip: "4.3.2.1" } as never)).resolves.toEqual({ ok: 2 });
        await expect(controller.verify2FALogin({} as never, { ip: "5.6.7.8" } as never)).resolves.toEqual({ ok: 3 });
        await expect(controller.sendAccountVerificationEmail({} as never)).resolves.toEqual({ ok: 4 });
        await expect(controller.verifyEmailOtp({} as never)).resolves.toEqual({ ok: 5 });
        await expect(controller.createPassword(user, {} as never)).resolves.toEqual({ ok: 6 });
        await expect(controller.onboardIndividual(user, {} as never)).resolves.toEqual({ ok: 7 });
        await expect(controller.bvnVerification(user, { bvn: "12345678901" } as never)).resolves.toEqual({ ok: 8 });
        await expect(controller.ninVerification(user, { nin: "12345678901" } as never)).resolves.toEqual({ ok: 9 });
        await expect(controller.sendPhoneVerificationOtp(user, {} as never)).resolves.toEqual({ ok: 10 });
        await expect(controller.verifyPhoneOtp(user, {} as never)).resolves.toEqual({ ok: 11 });

        expect(authService.signUp).toHaveBeenCalledWith({}, "1.2.3.4");
        expect(authService.userSignIn).toHaveBeenCalledWith({}, "4.3.2.1");
        expect(authService.verify2FALogin).toHaveBeenCalledWith({}, "5.6.7.8");
        expect(authService.bvnVerification).toHaveBeenCalledWith(user, { bvn: "12345678901" });
        expect(authService.ninVerification).toHaveBeenCalledWith(user, { nin: "12345678901" });
    });

    it("enforces required files for document verification and delegates success", async () => {
        await expect(
            controller.documentVerification(user, {} as never, { documentType: DocumentType.DRIVER_LICENSE } as never),
        ).rejects.toBeInstanceOf(RequiredFilesMissing);

        await expect(
            controller.documentVerification(
                user,
                { documentImage1: [{ originalname: "front.png" }] } as never,
                { documentType: DocumentType.INTERNATIONAL_PASSPORT } as never,
            ),
        ).rejects.toBeInstanceOf(RequiredFilesMissing);

        authService.documentVerification.mockResolvedValue({ verified: true });
        const files = {
            documentImage1: [{ originalname: "front.png" }],
            documentImage2: [{ originalname: "back.png" }],
        };

        await expect(
            controller.documentVerification(
                user,
                files as never,
                { documentType: DocumentType.INTERNATIONAL_PASSPORT } as never,
            ),
        ).resolves.toEqual({ verified: true });

        expect(authService.documentVerification).toHaveBeenCalledWith(
            user,
            files,
            { documentType: DocumentType.INTERNATIONAL_PASSPORT },
        );
    });

    it("validates base64 and preview document routes", async () => {
        await expect(controller.documentVerificationBase64(user, {} as never)).rejects.toBeInstanceOf(RequiredFilesMissing);
        await expect(controller.previewDocument(user, {} as never)).rejects.toBeInstanceOf(RequiredFilesMissing);

        authService.documentVerificationBase64.mockResolvedValue({ ok: true });
        authService.previewDocument.mockResolvedValue({ data: { name: "John" } });

        await expect(
            controller.documentVerificationBase64(user, { imageFrontBase64: "abc" } as never),
        ).resolves.toEqual({ ok: true });
        await expect(
            controller.previewDocument(user, { imageFrontBase64: "abc" } as never),
        ).resolves.toEqual({ data: { name: "John" } });
    });

    it("returns retired response for Dojah widget route and still delegates business routes", async () => {
        authService.submitDojahWidgetVerification.mockRejectedValue(
            new Error("Dojah widget verification has been retired. Use the document upload flow instead."),
        );
        authService.submitBusinessRecord.mockResolvedValue({ ok: "record" });
        authService.submitBusinessDocumentsFromUrls.mockResolvedValue({ ok: "urls" });

        await expect(
            controller.submitDojahVerification(
                user,
                { verificationId: "v1", referenceId: "r1", idData: { firstName: "A" } } as never,
            ),
        ).rejects.toThrow("Dojah widget verification has been retired");

        await expect(controller.submitBusinessRecord(user, {} as never)).resolves.toEqual({ ok: "record" });
        await expect(controller.submitBusinessDocuments(user, {} as never)).resolves.toEqual({ ok: "urls" });

        expect(authService.submitDojahWidgetVerification).toHaveBeenCalled();
        expect(authService.submitBusinessRecord).toHaveBeenCalledWith(user, {});
        expect(authService.submitBusinessDocumentsFromUrls).toHaveBeenCalledWith(user, {});
    });

    it("enforces required files for business upload endpoints and delegates success", async () => {
        await expect(controller.updloadBusinessDocuments(user, {} as never, {} as never)).rejects.toBeInstanceOf(RequiredFilesMissing);
        await expect(controller.uploadBusinessDocumentFile(user, undefined as never, {} as never)).rejects.toBeInstanceOf(RequiredFilesMissing);

        authService.updloadBusinessDocuments.mockResolvedValue({ ok: "multi" });
        authService.uploadSingleBusinessDocumentFile.mockResolvedValue({ ok: "single" });

        const docs = { cacImage: [{ originalname: "cac.pdf" }] };
        const file = { originalname: "single.pdf" };

        await expect(controller.updloadBusinessDocuments(user, docs as never, { size: "small" } as never)).resolves.toEqual({ ok: "multi" });
        await expect(controller.uploadBusinessDocumentFile(user, file as never, { fileType: "cac" } as never)).resolves.toEqual({ ok: "single" });

        expect(authService.updloadBusinessDocuments).toHaveBeenCalledWith(user, docs, { size: "small" });
        expect(authService.uploadSingleBusinessDocumentFile).toHaveBeenCalledWith(user, file, { fileType: "cac" });
    });

    it("delegates reset, refresh, and tier verification routes", async () => {
        authService.requestPasswordReset.mockResolvedValue({ ok: "forgot" });
        authService.resetPassword.mockResolvedValue({ ok: "reset" });
        authService.refreshToken.mockResolvedValue({ ok: "refresh" });

        tierVerificationService.verifyAddress.mockResolvedValue({ ok: "address" });
        tierVerificationService.verifyIncome.mockResolvedValue({ ok: "income" });
        tierVerificationService.createTradingPassword.mockResolvedValue({ ok: "trading" });
        tierVerificationService.hasTradingPassword.mockResolvedValue({ hasPassword: true });
        tierVerificationService.getVerificationStatus.mockResolvedValue({ tier: 2 });

        await expect(controller.forgotPassword({ email: "a@b.com" } as never)).resolves.toEqual({ ok: "forgot" });
        await expect(controller.resetPassword({ token: "t" } as never)).resolves.toEqual({ ok: "reset" });
        await expect(controller.refreshToken({ refreshToken: "r" } as never)).resolves.toEqual({ ok: "refresh" });

        await expect(controller.verifyAddress(user, undefined as never)).rejects.toBeInstanceOf(RequiredFilesMissing);
        await expect(controller.verifyIncome(user, undefined as never)).rejects.toBeInstanceOf(RequiredFilesMissing);

        await expect(controller.verifyAddress(user, { originalname: "address.pdf" } as never)).resolves.toEqual({ ok: "address" });
        await expect(controller.verifyIncome(user, { originalname: "income.pdf" } as never)).resolves.toEqual({ ok: "income" });
        await expect(controller.createTradingPassword(user, { password: "abc" } as never)).resolves.toEqual({ ok: "trading" });
        await expect(controller.hasTradingPassword(user)).resolves.toEqual({ hasPassword: true });
        await expect(controller.getVerificationStatus(user)).resolves.toEqual({ tier: 2 });
    });
});