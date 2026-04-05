import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import {
    SignUpDto,
    UserSigInDto,
    SendEmailVerificationCodeDto,
    VerifyEmailOtpDto,
    CreatePasswordDto,
    BvnVerificationDto,
    NinVerificationDto,
    OnboardIndividualDto,
    VerifyPhoneOtpDto,
    SendPhoneVerificationCodeDto,
    DocumentVerificationDto,
    DocumentVerificationBase64Dto,
    DocumentPreviewDto,
    DojahWidgetVerificationDto,
    SubmitBusinessRecordDto,
    SendForgotPasswordDto,
    ResetPasswordDto,
    ValidateAdminInviteDto,
    AcceptAdminInviteDto,
    RefreshTokenDto,
    BusinessDocumentUploadDto,
    UploadBusinessDocumentFileDto,
    SubmitBusinessDocumentsDto,
    Verify2FALoginDto,
} from "../dtos";
import * as bcrypt from "bcryptjs";
import { ApiResponse, buildResponse } from "@/utils/api-response-util";
import { PrismaService } from "@/modules/core/prisma/services";
import { EmailService } from "@/modules/core/email/services";
import { generateFileName, generateId, generateRandomNum, decryptField } from "@/utils";
import { customAlphabet } from "nanoid";
import { DuplicateUserException } from "../../user";
import {
    UserNotFoundException,
    InvalidCredentialException,
    Invalid2FACodeException,
    TwoFactorLockedException,
    InvalidEmailVerificationCodeException,
    VerificationCodeExpiredException,
    DuplicateBvnVerificationException,
    DuplicateVerificationException,
    InvalidVerificationCodeException,
    VerificationGenericException,
    InvalidResetCodeException,
    ResetCodeExpiredException,
    InvalidResetRequestException,
    InvalidAdminInviteException,
    AdminInviteExpiredException,
    UserUnauthorizedException,
    InvalidRefreshToken,
    AuthGenericException,
    UserAccountDisabledException,
    RequiredFilesMissing,
} from "../errors";
import {
    DocumentVerificationStatus,
    IdentityIdType,
    Prisma,
    Status,
    User,
    UserType,
    DocumentType,
    Country,
} from "@prisma/client";
import { RoleNotFoundException } from "../../authorize/error";
import { ADMIN_USER_TYPES } from "../../authorize/decorator";
import {
    emailTemplateConfig,
    cloudinaryConfig,
    imagekitConfig,
    jwt_refresh_secret,
    jwtSecret,
    mailConfig,
    REFRESH_TOKEN_EXPIRATION,
    storageDirConfig,
    TOKEN_EXPIRATION,
    COMPANY_NAME,
    isProdEnvironment,
} from "@/config";
import axios from "axios";
import { UploadResponse } from "imagekit/dist/libs/interfaces";
import { ImagekitService } from "@/modules/core/upload/services/imagekit";
import { UploadFactory } from "@/modules/core/upload/services";
import { CloudinaryService } from "@/modules/core/upload/services/cloudinary";
import { UploadApiResponse } from "cloudinary";

type UploadResult = UploadResponse | UploadApiResponse;

import { IdentityComplianceInjectionToken } from "@/modules/factory/identityCompliance/types";
import { DojahService } from "@/modules/factory/identityCompliance/providers/dojah/services";
import {
    DocumentMetaMap,
    DataStoredInToken,
    DocumentVerificationFileInterface,
    LoginPlatform,
    SignInOptions,
    UploadBusinessDocumentsFileInterface,
    VerificationStatus,
    SignInUser,
} from "../interfaces";
import { CryptoAccountQueueProducer } from "../../trade/queues/producers/producer.service";
import { authenticator } from "otplib";
import * as crypto from "node:crypto";
import { SmsService } from "@/modules/core/sms/services";
import { SessionService } from "../../session/services";
import { SessionInfo } from "../../session/interfaces";
import { TwoFactorRateLimitService } from "./two-factor-rate-limit.service";
import { SettingService } from "../../settings/services";
import { TierService } from "./tier.service";
import { KycStateMachineService } from "./kyc-state-machine.service";
import { IdentityResolutionService } from "./identity-resolution.service";
import { matchNames, matchDateOfBirth } from "@/utils/name-matcher";

import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { DistributedLockService } from "@/modules/core/redisCache/services/distributed-lock.service";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import { WsGateway } from "@/modules/api/trade/gateway/v1";

/**
 * Build a spread-safe object for a file field in update operations.
 * Returns an empty object if the file is not present, avoiding inline ternaries.
 */
function fileFieldUpdate(
    file: { url: string; fileId: string; originalName?: string } | null,
    urlProp: string,
    fieldIdProp: string,
    fileNameProp: string,
    metaKey: string,
    userId: number,
): any {
    if (!file) return {};
    return {
        [urlProp]: file.url,
        [fieldIdProp]: file.fileId,
        [fileNameProp]: generateFileName(metaKey, userId, file.originalName),
    };
}

/**
 * Build file field values for create operations.
 * Returns null values if no file, avoiding inline ternaries.
 */
function fileFieldCreate(
    file: { url: string; fileId: string; originalName?: string } | null,
    urlProp: string,
    fieldIdProp: string,
    fileNameProp: string,
    metaKey: string,
    userId: number,
): any {
    return {
        [urlProp]: file?.url || null,
        [fieldIdProp]: file?.fileId || null,
        [fileNameProp]: file ? generateFileName(metaKey, userId, file.originalName) : null,
    };
}

@Injectable()
export class AuthService {
    private readonly logger = new Logger(AuthService.name);
    private readonly uploadService: ImagekitService | CloudinaryService;
    private readonly SALT_ROUNDS = 10;
    private readonly SIGNUP_CACHE_TTL = 3600; // 1 hour
    private readonly getProfileCacheKey = (userId: number) => `user:profile:${userId}`;

    private maskSensitiveId(value?: string, visibleDigits: number = 4): string {
        if (!value) return "N/A";
        if (value.length <= visibleDigits) return value;
        return `${"*".repeat(Math.max(0, value.length - visibleDigits))}${value.slice(-visibleDigits)}`;
    }

    private deriveAdminUserType(roleSlug: string): UserType {
        return roleSlug === "super-admin" ? UserType.SUPER_ADMIN : UserType.ADMIN;
    }

    /**
     * Map Dojah error types to user-friendly messages
     */
    private mapDojahErrorToUserMessage(error: { name: string; message: string; status?: number }): string {
        const errorName = error.name?.toLowerCase() || '';
        const errorMessage = error.message?.toLowerCase() || '';

        // Network/timeout errors
        if (errorName.includes('network') || errorName.includes('timeout') || errorMessage.includes('timeout')) {
            return 'Connection issue with verification service. Please try again in a moment.';
        }

        // Validation errors - usually means image quality or format issues
        if (errorName.includes('validation') || error.status === 400) {
            if (errorMessage.includes('base64') || errorMessage.includes('image')) {
                return 'Invalid image format. Please upload a clear photo of your document.';
            }
            if (errorMessage.includes('size') || errorMessage.includes('large')) {
                return 'Image file is too large. Please upload a smaller image.';
            }
            return 'Document image could not be processed. Please ensure the image is clear and try again.';
        }

        // Not found - document type not recognized
        if (errorName.includes('notfound') || error.status === 404) {
            return 'Could not recognize this document type. Please upload a valid government-issued ID.';
        }

        // Third party service failure
        if (errorName.includes('thirdparty') || error.status === 424) {
            return 'Verification service is temporarily unavailable. Please try again in a few minutes.';
        }

        // Rate limiting
        if (errorName.includes('toomany') || error.status === 429) {
            return 'Too many verification attempts. Please wait a few minutes before trying again.';
        }

        // Authorization errors (internal issue)
        if (errorName.includes('authorization') || error.status === 401) {
            return 'Verification service configuration error. Please contact support.';
        }

        // Default message with the original error for debugging
        const originalMessage = error.message || 'Unknown error';
        return `Document verification failed: ${originalMessage}. Please try with a clearer image.`;
    }

    private applyDojahPostValidation(
        isDocumentValid: boolean,
        dojahParsed: any,
        userId: number,
        logger: Logger,
    ): boolean {
        if (isDocumentValid && this.isDocumentExpired(dojahParsed?.expiryDate)) {
            logger.warn(`Document for user ${userId} is expired: ${dojahParsed?.expiryDate}`);
            if (dojahParsed) {
                dojahParsed.reason = "Document has expired";
            }
            isDocumentValid = false;
        }

        logger.log(
            `Document analysis for user ${userId}: ` +
            `valid=${isDocumentValid}, ` +
            `docType=${dojahParsed?.documentType || "unknown"}, ` +
            `expiryDate=${dojahParsed?.expiryDate || "unknown"}, ` +
            `reason=${dojahParsed?.reason || "unknown"}`
        );

        if (!isDocumentValid && dojahParsed?.reason) {
            this.checkHardRejectDocument(dojahParsed.reason, userId, dojahParsed.hasExtractedText, logger);
        }

        return isDocumentValid;
    }

    /**
     * Hard-reject documents that are expired or unsupported.
     * For other failure reasons, log and allow through for manual review.
     */
    private checkHardRejectDocument(
        reason: string,
        userId: number,
        hasExtractedText: boolean | undefined,
        logger: Logger,
    ): void {
        const upper = reason.toUpperCase();

        if (upper.includes("EXPIRED")) {
            throw new VerificationGenericException(
                "Document appears to be expired. Please upload a valid, unexpired document.",
                HttpStatus.BAD_REQUEST
            );
        }
        if (upper.includes("NOT_SUPPORTED") || upper.includes("UNSUPPORTED")) {
            throw new VerificationGenericException(
                "This document type is not supported. Please upload a valid passport, driver's license, or national ID.",
                HttpStatus.BAD_REQUEST
            );
        }

        // For NOT_VALID / INVALID / other reasons: allow through for manual review
        logger.log(
            `Document for user ${userId} is not auto-verified (reason=${reason}), ` +
            `hasExtractedText=${hasExtractedText} — saving for manual review`
        );
    }

    /**
     * Call Dojah document verification API with base64 images.
     * Returns a structured result, never throws.
     */
    private async callDojahDocumentVerification(
        cleanFrontBase64: string,
        cleanBackBase64: string | undefined,
        user: User,
        dto: DocumentVerificationBase64Dto,
        startTime: number,
        logger: Logger,
    ) {
        try {
            const verificationResult = await this.dojahService.verifyDocumentWithNameMatch(
                {
                    inputType: "base64",
                    imageFrontSide: cleanFrontBase64,
                    ...(cleanBackBase64 && { imageBackSide: cleanBackBase64 }),
                },
                user.firstName,
                user.lastName
            );
            logger.log(`Dojah API completed in ${Date.now() - startTime}ms for user ${user.id}`);
            return {
                success: true,
                isValid: verificationResult.isValid,
                nameMatches: verificationResult.nameMatches,
                parsed: verificationResult.parsed,
                raw: JSON.stringify(verificationResult),
                error: null,
            };
        } catch (error) {
            logger.error(`Dojah document analysis failed for user ${user.id}`, {
                errorName: error.name,
                errorMessage: error.message,
                errorStatus: error.status,
                errorStack: error.stack,
                durationMs: Date.now() - startTime,
                payloadSize: {
                    frontImage: dto.imageFrontBase64?.length || 0,
                    backImage: dto.imageBackBase64?.length || 0,
                },
            });
            return {
                success: false,
                isValid: false,
                nameMatches: false,
                parsed: null,
                raw: null,
                error: {
                    name: error.name,
                    message: error.message,
                    status: error.status,
                },
            };
        }
    }

    /**
     * Check if a document is expired based on expiry date string
     * Returns true if expired, false if valid or no expiry date
     */
    private isDocumentExpired(expiryDateStr: string | null | undefined): boolean {
        if (!expiryDateStr) return false;

        try {
            // Parse common date formats (YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY)
            let expiryDate: Date | null = null;

            if (/^\d{4}-\d{2}-\d{2}$/.test(expiryDateStr)) {
                // YYYY-MM-DD format
                expiryDate = new Date(expiryDateStr);
            } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(expiryDateStr)) {
                // DD/MM/YYYY format
                const [day, month, year] = expiryDateStr.split('/');
                expiryDate = new Date(`${year}-${month}-${day}`);
            } else if (/^\d{2}-\d{2}-\d{4}$/.test(expiryDateStr)) {
                // DD-MM-YYYY format
                const [day, month, year] = expiryDateStr.split('-');
                expiryDate = new Date(`${year}-${month}-${day}`);
            } else {
                // Try parsing as generic date
                expiryDate = new Date(expiryDateStr);
            }

            if (Number.isNaN(expiryDate.getTime())) {
                this.logger.warn(`Could not parse expiry date: ${expiryDateStr}`);
                return false;
            }

            const today = new Date();
            today.setHours(0, 0, 0, 0);

            return expiryDate < today;
        } catch (error) {
            this.logger.warn(`Error parsing expiry date ${expiryDateStr}:`, error);
            return false;
        }
    }

    constructor(
        private readonly jwtService: JwtService,
        private readonly prisma: PrismaService,
        private readonly emailService: EmailService,
        private readonly uploadFactory: UploadFactory,
        @Inject(IdentityComplianceInjectionToken.DOJAH)
        private readonly dojahService: DojahService,
        private readonly cryptoAccountQueueProducer: CryptoAccountQueueProducer,
        private readonly smsService: SmsService,
        private readonly sessionService: SessionService,
        private readonly twoFactorRateLimitService: TwoFactorRateLimitService,
        private readonly settingService: SettingService,
        private readonly tierService: TierService,
        private readonly redisCacheService: RedisCacheService,
        private readonly distributedLockService: DistributedLockService,
        private readonly kycStateMachine: KycStateMachineService,
        private readonly notificationDispatcher: NotificationDispatcher,
        private readonly wsGateway: WsGateway,
        private readonly identityResolution: IdentityResolutionService,
    ) {
        this.uploadService = this.uploadFactory.build({
            provider: "imagekit",
        });
    }

    // Separated platform validation logic
    private validateLoginPlatform(
        userType: UserType,
        loginPlatform: LoginPlatform
    ): void {
        switch (loginPlatform) {
            case LoginPlatform.ADMIN:
                if (!ADMIN_USER_TYPES.includes(userType)) {
                    throw new InvalidCredentialException(
                        "Incorrect email or password",
                        HttpStatus.UNAUTHORIZED
                    );
                }
                break;
            case LoginPlatform.USER:
                if (ADMIN_USER_TYPES.includes(userType)) {
                    throw new InvalidCredentialException(
                        "Incorrect email or password",
                        HttpStatus.UNAUTHORIZED
                    );
                }
                break;
            default:
                throw new AuthGenericException(
                    "Invalid login platform",
                    HttpStatus.INTERNAL_SERVER_ERROR
                );
        }
    }

    // SECURITY: Account lockout after failed login attempts
    private readonly MAX_FAILED_ATTEMPTS = 5;
    private readonly LOCKOUT_DURATION_MINUTES = 30;

    private async handleFailedLogin(
        user: SignInUser,
        ip: string
    ): Promise<void> {
        const now = new Date();
        const lockoutWindow = new Date(now.getTime() - this.LOCKOUT_DURATION_MINUTES * 60 * 1000);

        // Check if user is currently locked out
        if ((user as any).lockedUntil && new Date((user as any).lockedUntil) > now) {
            const remainingMinutes = Math.ceil(
                (new Date((user as any).lockedUntil).getTime() - now.getTime()) / 60000
            );
            throw new UserAccountDisabledException(
                `Account temporarily locked due to too many failed attempts. Try again in ${remainingMinutes} minutes.`,
                HttpStatus.TOO_MANY_REQUESTS
            );
        }

        // Reset counter if outside lockout window
        let failedAttempts = (user as any).failedLoginAttempts || 0;
        const lastFailedLogin = (user as any).lastFailedLogin;
        if (lastFailedLogin && new Date(lastFailedLogin) < lockoutWindow) {
            failedAttempts = 0;
        }

        failedAttempts++;

        const updateData: any = {
            failedLoginAttempts: failedAttempts,
            lastFailedLogin: now,
            ipAddress: ip,
        };

        // Lock account after MAX_FAILED_ATTEMPTS
        if (failedAttempts >= this.MAX_FAILED_ATTEMPTS) {
            updateData.lockedUntil = new Date(now.getTime() + this.LOCKOUT_DURATION_MINUTES * 60 * 1000);

            // Also flag the account
            await this.prisma.$transaction(async (tx) => {
                const flaggedRecord = await tx.flagged.upsert({
                    where: { userId: user.id },
                    create: {
                        userId: user.id,
                        flagged: true,
                        reason: `Account locked: ${this.MAX_FAILED_ATTEMPTS} failed login attempts`,
                    },
                    update: {
                        flagged: true,
                        reason: `Account locked: ${this.MAX_FAILED_ATTEMPTS} failed login attempts`,
                        updatedAt: now,
                    },
                });

                await tx.user.update({
                    where: { id: user.id },
                    data: {
                        ...updateData,
                        flaggedId: flaggedRecord.id,
                    },
                });
            });

            this.logger.warn(`Account locked for user ${user.id} after ${this.MAX_FAILED_ATTEMPTS} failed attempts from IP: ${ip}`);

            throw new UserAccountDisabledException(
                `Account temporarily locked due to too many failed attempts. Try again in ${this.LOCKOUT_DURATION_MINUTES} minutes.`,
                HttpStatus.TOO_MANY_REQUESTS
            );
        }

        await this.prisma.user.update({
            where: { id: user.id },
            data: updateData,
        });
    }

    async hashPassword(password: string): Promise<string> {
        return await bcrypt.hash(password, this.SALT_ROUNDS);
    }

    async comparePassword(password: string, hash: string): Promise<boolean> {
        return await bcrypt.compare(password, hash);
    }

    /**
     * Get default security methods structure
     */
    private getDefaultSecurityMethods() {
        return {
            sms: false,
            email: false,
            authenticator: false,
            tradingPassword: false,
        };
    }

    /**
     * Get or create security methods for a user by email
     */
    private async getOrCreateSecurityMethods(email: string, _methodType: 'email' | 'sms') {
        const user = await this.prisma.user.findUnique({
            where: { email },
            select: { securityMethods: true },
        });
        return (user?.securityMethods as any) || this.getDefaultSecurityMethods();
    }

    /**
     * Get or create security methods for a user by phone
     */
    private async getOrCreateSecurityMethodsByPhone(phone: string) {
        const user = await this.prisma.user.findUnique({
            where: { phone },
            select: { securityMethods: true },
        });
        return (user?.securityMethods as any) || this.getDefaultSecurityMethods();
    }

    async generateTokens(payload: any) {
        const accessToken = await this.jwtService.signAsync(payload, {
            secret: jwtSecret,
            expiresIn: TOKEN_EXPIRATION,
        });

        const refreshToken = await this.jwtService.signAsync(payload, {
            secret: jwt_refresh_secret,
            expiresIn: REFRESH_TOKEN_EXPIRATION,
        });

        return { accessToken, refreshToken };
    }

    async requestPasswordReset(
        dto: SendForgotPasswordDto
    ): Promise<ApiResponse> {
        const email = dto.email.toLowerCase().trim();
        const user = await this.prisma.user.findUnique({
            where: { email },
        });
        if (!user) {
            throw new UserNotFoundException("User not found");
        }

        const code = crypto.randomBytes(4).toString("hex").toUpperCase();

        await this.prisma.passwordResetRequest.deleteMany({
            where: { userId: user.id },
        });

        await this.prisma.passwordResetRequest.create({
            data: {
                userId: user.id,
                code: code,
                createdAt: new Date(),
                updatedAt: new Date(),
            },
        });

        const name =
            `${user.firstName || ""} ${user.lastName || ""}`.trim() || "User";
        const username = user.email;
        const team = COMPANY_NAME;

        try {
            await this.emailService.sendMailWithTemplate({
                from: { address: mailConfig.senderMail },
                to: [{ email_address: { address: email } }],
                template_key: emailTemplateConfig.forgot_password,
                merge_info: {
                    name,
                    product_name: COMPANY_NAME,
                    otp: code,                  // Use otp instead of password_reset_link
                    expiry_minutes: "30",       // Match template variable
                    username,
                    team,
                },
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to send password reset email: ${errorMessage}`);
            throw new AuthGenericException(
                "Failed to send password reset email",
                HttpStatus.BAD_REQUEST,
                {
                    cause: error instanceof Error ? error : new Error(errorMessage),
                }
            );
        }

        return buildResponse({
            message: "Password reset email sent successfully",
            data: { email },
        });
    }

    async resetPassword(dto: ResetPasswordDto): Promise<ApiResponse> {
        const email = dto.email.toLowerCase().trim();
        const user = await this.prisma.user.findUnique({
            where: { email },
            include: { passwordResetRequest: true },
        });

        if (!user?.passwordResetRequest) {
            throw new InvalidResetRequestException(
                "Invalid password reset request"
            );
        }

        const resetCodeMatch =
            user.passwordResetRequest.code.length === dto.resetCode.length &&
            crypto.timingSafeEqual(
                Buffer.from(user.passwordResetRequest.code, "utf8"),
                Buffer.from(dto.resetCode, "utf8")
            );
        if (!resetCodeMatch) {
            throw new InvalidResetCodeException("Invalid reset code");
        }

        const createdAt = user.passwordResetRequest.createdAt;
        if (Date.now() - createdAt.getTime() > 30 * 60 * 1000) {
            await this.prisma.passwordResetRequest.delete({
                where: { userId: user.id },
            });
            throw new ResetCodeExpiredException("Reset code has expired");
        }

        const isSameAsCurrentPassword = await this.comparePassword(
            dto.password,
            user.password
        );

        if (isSameAsCurrentPassword) {
            throw new InvalidResetRequestException(
                "Your new password must be different from your current password",
                HttpStatus.BAD_REQUEST
            );
        }

        const hashedPassword = await this.hashPassword(dto.password);

        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                password: hashedPassword,
                passwordChangedAt: new Date(),
                updatedAt: new Date(),
            },
        });

        await this.prisma.passwordResetRequest.delete({
            where: { userId: user.id },
        });

        return buildResponse({
            message: "Password reset successfully",
        });
    }

    async validateAdminInvite(dto: ValidateAdminInviteDto): Promise<ApiResponse> {
        const token = dto.token.trim();

        const invite = await (this.prisma as any).adminInvite.findUnique({
            where: { token },
            include: {
                role: {
                    select: {
                        id: true,
                        name: true,
                        slug: true,
                    },
                },
            },
        });

        if (!invite || invite.acceptedAt) {
            throw new InvalidAdminInviteException();
        }

        if (invite.expiresAt.getTime() < Date.now()) {
            throw new AdminInviteExpiredException();
        }

        return buildResponse({
            message: "Admin invite is valid",
            data: {
                email: invite.email,
                firstName: invite.firstName,
                lastName: invite.lastName,
                role: invite.role,
                expiresAt: invite.expiresAt,
            },
        });
    }

    async acceptAdminInvite(dto: AcceptAdminInviteDto): Promise<ApiResponse> {
        const token = dto.token.trim();
        const phone = dto.phone.trim();

        const invite = await (this.prisma as any).adminInvite.findUnique({
            where: { token },
            include: {
                role: {
                    select: {
                        id: true,
                        name: true,
                        slug: true,
                        isAdmin: true,
                    },
                },
            },
        });

        if (!invite || invite.acceptedAt) {
            throw new InvalidAdminInviteException();
        }

        if (invite.expiresAt.getTime() < Date.now()) {
            throw new AdminInviteExpiredException();
        }

        const existingUser = await this.prisma.user.findUnique({
            where: { email: invite.email },
        });

        if (existingUser) {
            throw new DuplicateUserException(
                "An account with this email already exists. Please login",
                HttpStatus.BAD_REQUEST,
            );
        }

        if (!invite.role.isAdmin) {
            throw new RoleNotFoundException(
                "Admin role not found",
                HttpStatus.NOT_FOUND,
            );
        }

        const existingPhone = await this.prisma.user.findUnique({
            where: { phone },
            select: { id: true },
        });

        if (existingPhone) {
            throw new DuplicateUserException(
                "Phone number is already in use",
                HttpStatus.BAD_REQUEST,
            );
        }

        const hashedPassword = await this.hashPassword(dto.password);
        const identifier = generateId({ type: "identifier" });

        const [admin] = await this.prisma.$transaction([
            this.prisma.user.create({
                data: {
                    identifier,
                    firstName: invite.firstName,
                    lastName: invite.lastName,
                    email: invite.email,
                    phone,
                    password: hashedPassword,
                    userType: this.deriveAdminUserType(invite.role.slug),
                    roleId: invite.roleId,
                    isEmailVerified: true,
                    isPasswordCreated: true,
                    status: Status.ACTIVE,
                },
                select: {
                    id: true,
                    identifier: true,
                    firstName: true,
                    lastName: true,
                    email: true,
                    role: {
                        select: {
                            id: true,
                            name: true,
                            slug: true,
                        },
                    },
                    createdAt: true,
                },
            }),
            (this.prisma as any).adminInvite.update({
                where: { id: invite.id },
                data: { acceptedAt: new Date() },
            }),
        ]);

        this.logger.log(`Admin invite accepted for ${invite.email}`);

        return buildResponse({
            message: "Admin account created successfully",
            data: admin,
        });
    }

    async signUp(options: SignUpDto, ip: string): Promise<ApiResponse> {
        const email = options.email.toLowerCase().trim();
        const existingUser = await this.prisma.user.findUnique({
            where: { email },
            include: {
                flaggedRecord: true
            }
        });

        // Allow re-registration if user was deleted
        if (existingUser && !existingUser.isDeleted) {
            throw new DuplicateUserException(
                "An account with this email already exist. Please login",
                HttpStatus.BAD_REQUEST
            );
        }

        // Security: Prevent blocked/flagged users from bypassing bans via re-registration
        if (existingUser?.isDeleted) {
            // Check if user was blocked
            if (existingUser.status === Status.BLOCKED) {
                throw new UserAccountDisabledException(
                    "This account has been permanently blocked. Please contact support.",
                    HttpStatus.FORBIDDEN
                );
            }

            // Check if user was flagged
            if (existingUser.flaggedRecord?.flagged) {
                throw new UserAccountDisabledException(
                    `This account has been flagged: ${existingUser.flaggedRecord.reason || 'Policy violation'}. Please contact support.`,
                    HttpStatus.FORBIDDEN
                );
            }

            // Allow re-registration for non-blocked, non-flagged deleted accounts
            Logger.log(`Removing deleted account for re-registration: ${existingUser.email}`);
            await this.prisma.user.delete({
                where: { id: existingUser.id },
            });
        }

        // Validate role exists
        const role = await this.prisma.role.findUnique({
            where: {
                slug: options.accountType.toLowerCase(),
            },
        });

        if (!role) {
            throw new RoleNotFoundException(
                "Role not found",
                HttpStatus.NOT_FOUND
            );
        }

        // Store signup data in Redis instead of creating user
        const cacheKey = `pending_signup:${email}`;
        const signupData = {
            ...options,
            email, // Store normalized email
            ipAddress: ip,
            roleId: role.id
        };

        await this.redisCacheService.set(cacheKey, signupData, this.SIGNUP_CACHE_TTL);

        // DO NOT send email here. It will be sent when user selects verification method.

        return buildResponse({
            message: "Account initialization successful. Please proceed to verification.",
        });
    }

    async sendAccountVerificationEmail(
        options: SendEmailVerificationCodeDto
    ): Promise<ApiResponse> {
        const verificationCode = customAlphabet("1234567890", 6)();
        const email = options.email.toLowerCase().trim();

        // Check if user exists in DB
        const emailExist = await this.prisma.user.findUnique({
            where: { email: email },
            select: { id: true, isEmailVerified: true, firstName: true },
        });

        let firstName: string;

        if (emailExist) {
            // Case 1: User already exists
            if (emailExist.isEmailVerified) {
                throw new DuplicateUserException(
                    "Account already verified. Kindly login",
                    HttpStatus.BAD_REQUEST
                );
            }
            firstName = emailExist.firstName || "User";
        } else {
            // Case 2: Check Redis for pending signup
            const cacheKey = `pending_signup:${email}`;
            const cachedSignup = await this.redisCacheService.get<any>(cacheKey);

            if (!cachedSignup) {
                throw new UserNotFoundException(
                    "Account with email not found. Kindly register first",
                    HttpStatus.BAD_REQUEST
                );
            }
            firstName = cachedSignup.firstName || "User";
        }

        await this.prisma.accountVerificationRequest.upsert({
            where: {
                email: options.email,
            },
            create: {
                code: verificationCode,
                email: options.email,
            },
            update: {
                code: verificationCode,
            },
        });

        try {
            await this.emailService.sendMailWithTemplate({
                from: { address: mailConfig.senderMail },
                to: [{ email_address: { address: options.email } }],
                template_key: emailTemplateConfig.verify_account,
                merge_info: {
                    otp: verificationCode, // Matches {{otp}}
                    expiry_minutes: "10",  // Matches {{expiry_minutes}}
                    name: firstName,       // Matches {{name}}
                    product_name: COMPANY_NAME,
                    team: COMPANY_NAME,
                },
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to send account verification email: ${errorMessage}`);
            throw new AuthGenericException(
                "Failed to send account verification email",
                HttpStatus.BAD_REQUEST,
                {
                    cause: error instanceof Error ? error : new Error(errorMessage),
                }
            );
        }

        return buildResponse({
            message: `An email verification code has been sent to your email, ${options.email}`,
            data: {
                email: options.email,
            },
        });
    }

    async verifyEmailOtp(options: VerifyEmailOtpDto): Promise<ApiResponse> {
        const email = options.email.toLowerCase().trim();
        let user: User;
        let isNewUser = false;

        // Check if user exists in DB
        const emailExist = await this.prisma.user.findUnique({
            where: { email },
        });

        if (emailExist) {
            if (emailExist.isEmailVerified) {
                throw new DuplicateUserException(
                    "Account already verified. Kindly login",
                    HttpStatus.BAD_REQUEST
                );
            }
        } else {
            // Check Redis for pending signup
            const cacheKey = `pending_signup:${email}`;
            const cachedSignup = await this.redisCacheService.get<any>(cacheKey);

            if (!cachedSignup) {
                throw new UserNotFoundException(
                    "Account with email not found or signup session expired. Kindly register again",
                    HttpStatus.BAD_REQUEST
                );
            }
            isNewUser = true;
        }

        const verificationData =
            await this.prisma.accountVerificationRequest.findUnique({
                where: {
                    email_code: { email, code: options.otp },
                },
            });

        if (!verificationData) {
            throw new InvalidEmailVerificationCodeException(
                "Invalid verification code",
                HttpStatus.BAD_REQUEST
            );
        }

        // SECURITY: OTP codes expire after 10 minutes
        const TEN_MINUTES_MS = 10 * 60 * 1000;
        const timeDifference =
            Date.now() - verificationData.updatedAt.getTime();

        if (timeDifference > TEN_MINUTES_MS) {
            // Clean up expired code
            await this.prisma.accountVerificationRequest.delete({
                where: { email },
            }).catch(() => { }); // Ignore if already deleted

            throw new VerificationCodeExpiredException(
                "Your verification code has expired (valid for 10 minutes). Please request a new one.",
                HttpStatus.BAD_REQUEST
            );
        }

        if (isNewUser) {
            // Create the user now
            const cacheKey = `pending_signup:${email}`;
            const cachedSignup = await this.redisCacheService.get<any>(cacheKey); // Fetch again to be safe

            const createUserOptions: Prisma.UserUncheckedCreateInput = {
                email: cachedSignup.email,
                identifier: generateId({ type: "identifier" }),
                userType: cachedSignup.accountType,
                roleId: cachedSignup.roleId,
                ipAddress: cachedSignup.ipAddress,
                firstName: cachedSignup.firstName,
                lastName: cachedSignup.lastName,
                businessName: cachedSignup.businessName?.trim() || null,
                dateOfBirth: new Date(cachedSignup.dateOfBirth),
                isEmailVerified: true,
                securityMethods: {
                    sms: false,
                    email: true, // Enable email as security method
                    authenticator: false,
                    tradingPassword: false,
                },
            };

            user = await this.prisma.user.create({
                data: createUserOptions,
            });

            // Clean up Redis
            await this.redisCacheService.del(cacheKey);
        } else {
            // Update existing user
            user = await this.prisma.user.update({
                where: { email },
                data: {
                    isEmailVerified: true,
                    // Auto-enable email as a security method
                    securityMethods: {
                        ...await this.getOrCreateSecurityMethods(email, 'email'),
                        email: true,
                    },
                },
            });
        }

        await this.prisma.accountVerificationRequest.delete({
            where: { email },
        });

        // Sync tier & flush profile cache after email verification
        await this.tierService.syncTierAndCache(user.id);

        // Generate tokens for auto-login
        const tokens = await this.generateTokens({
            sub: user.id,
        });
        await this.saveRefreshToken(user.id, tokens.refreshToken);

        return buildResponse({
            message: "Email verification completed",
            data: tokens, // Return tokens to allow auto-login on frontend
        });
    }

    async sendPhoneVerificationOtp(
        user: User,
        options: SendPhoneVerificationCodeDto
    ): Promise<ApiResponse> {
        const verificationCode = customAlphabet("1234567890", 6)();

        if (user.isPhoneVerified) {
            throw new DuplicateVerificationException(
                "Phone number is already verified",
                HttpStatus.BAD_REQUEST
            );
        }

        const alreadyInUse = await this.prisma.user.findFirst({
            where: { id: { not: user.id }, phone: options.phone },
        });

        if (alreadyInUse) {
            throw new VerificationGenericException(
                "Phone is already in use by another account",
                HttpStatus.BAD_REQUEST
            );
        }

        await this.prisma.user.update({
            where: { id: user.id },
            data: { phone: options.phone },
        });

        await this.prisma.phoneVerificationRequest.upsert({
            where: {
                phone: options.phone,
            },
            create: {
                code: verificationCode,
                phone: options.phone,
            },
            update: {
                code: verificationCode,
            },
        });

        // Send verification code via SMS
        await this.smsService.sendVerificationCode(options.phone, verificationCode);

        return buildResponse({
            message: `A phone verification code has been sent to your phone, ${options.phone}`,
            data: {
                phone: options.phone,
            },
        });
    }

    async verifyPhoneOtp(
        user: User,
        options: VerifyPhoneOtpDto
    ): Promise<ApiResponse> {
        if (user.isPhoneVerified) {
            throw new DuplicateVerificationException(
                "Phone number already verified",
                HttpStatus.BAD_REQUEST
            );
        }

        const verificationData =
            await this.prisma.phoneVerificationRequest.findUnique({
                where: {
                    phone_code: { phone: options.phone, code: options.otp },
                },
            });

        if (!verificationData) {
            throw new InvalidVerificationCodeException(
                "Invalid phone verification code",
                HttpStatus.BAD_REQUEST
            );
        }

        // SECURITY: Phone OTP codes expire after 5 minutes
        const FIVE_MINUTES_MS = 5 * 60 * 1000;
        const timeDifference =
            Date.now() - verificationData.updatedAt.getTime();

        if (timeDifference > FIVE_MINUTES_MS) {
            throw new VerificationCodeExpiredException(
                "Your verification code has expired (valid for 5 minutes). Please request a new one.",
                HttpStatus.BAD_REQUEST
            );
        }

        await this.prisma.user.update({
            where: { phone: options.phone },
            data: {
                isPhoneVerified: true,
                // Auto-enable SMS as a security method
                securityMethods: {
                    ...await this.getOrCreateSecurityMethodsByPhone(options.phone),
                    sms: true,
                },
            },
        });

        await this.prisma.phoneVerificationRequest.delete({
            where: { phone: options.phone },
        });

        return buildResponse({
            message: "Phone verification completed",
        });
    }

    async createPassword(user: User, dto: CreatePasswordDto) {
        const hashedPassword = await this.hashPassword(dto.password);
        await this.prisma.user.update({
            where: { id: user.id },
            data: { password: hashedPassword, isPasswordCreated: true },
        });
        return buildResponse({
            message: "Password created successfully",
        });
    }

    private sendDocumentAutoApprovalNotifications(
        userId: number,
        userEmail: string,
        firstName: string,
        documentType: string,
        logger: Logger,
    ): void {
        if (emailTemplateConfig.document_approved) {
            this.emailService.sendMailWithTemplate({
                from: { address: mailConfig.senderMail },
                to: [{ email_address: { address: userEmail } }],
                template_key: emailTemplateConfig.document_approved,
                merge_info: {
                    first_name: firstName || "User",
                    document_type: documentType,
                    company_name: COMPANY_NAME,
                    rejection_reason: "",
                    status: "Approved",
                },
            }).catch((e) => logger.error(`[KYC][DOCUMENT] Failed to send approval email for user ${userId}: ${e instanceof Error ? e.message : String(e)}`));
        }
        this.notificationDispatcher.notify({
            userId,
            title: "Document Verified",
            body: "Your identity document has been verified successfully.",
            category: "security",
            enablePush: true,
        }).catch((e) => logger.error(`[KYC][DOCUMENT] Failed to send notification for user ${userId}: ${e instanceof Error ? e.message : String(e)}`));
        this.wsGateway.notifyProfileUpdate(userId);
    }

    private ensureIdentityProfilePresent(user: User, identityType: "BVN" | "NIN"): void {
        if (!user.firstName || !user.lastName || !user.dateOfBirth) {
            throw new VerificationGenericException(
                `Please complete your profile (name and date of birth) before verifying ${identityType}`,
                HttpStatus.BAD_REQUEST
            );
        }
    }

    private async updateIdentityWithConflictGuard(
        userId: number,
        identityType: "BVN" | "NIN",
        data: Prisma.UserUpdateInput,
    ): Promise<void> {
        try {
            await this.prisma.user.update({
                where: { id: userId },
                data,
            });
        } catch (err) {
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
                throw new VerificationGenericException(
                    `This ${identityType} is already linked to another account. If this is yours, please contact support.`,
                    HttpStatus.CONFLICT,
                );
            }
            throw err;
        }
    }

    private async rejectOnIdentityMismatch(
        user: User,
        result: any,
        identityType: "BVN" | "NIN",
    ): Promise<"MATCHED" | "PENDING_REVIEW"> {
        const nameResult = matchNames(
            user.firstName,
            user.lastName,
            result?.data?.entity?.first_name || "",
            result?.data?.entity?.last_name || "",
        );
        const dobMatches = matchDateOfBirth(
            user.dateOfBirth.toISOString().split("T")[0],
            result?.data?.entity?.date_of_birth || "",
        );

        if (!dobMatches) {
            this.logger.warn(`[KYC][${identityType}] User data mismatch for user ${user.id} after Dojah response`);
            await this.kycStateMachine.transition(user.id, identityType, "REJECTED", {
                providerRef: result?.data?.entity?.reference_id,
                providerRawResponse: result?.data,
                reviewNote: `Name/DOB mismatch: ${nameResult.detail}, dobMatches=${dobMatches}`,
            });
            throw new VerificationGenericException(
                "Incorrect first name, last name or date of birth",
                HttpStatus.BAD_REQUEST
            );
        }

        if (!nameResult.matches) {
            this.logger.warn(`[KYC][${identityType}] Name mismatch with DOB match for user ${user.id}; routing to manual review`);
            const transitionMeta = {
                providerRef: result?.data?.entity?.reference_id,
                providerRawResponse: result?.data,
                reviewNote: `DOB matched but names mismatched. ${nameResult.detail}`,
            };

            try {
                await this.kycStateMachine.transition(user.id, identityType, "PENDING", transitionMeta);
            } catch {
                // If an active REJECTED record exists, reopen via RESUBMITTED -> PENDING.
                await this.kycStateMachine.transition(user.id, identityType, "RESUBMITTED", transitionMeta);
            }

            return "PENDING_REVIEW";
        }

        return "MATCHED";
    }

    private async processDevIdentityBypass(
        userId: number,
        identityType: "BVN" | "NIN",
    ): Promise<void> {
        const generatedValue = generateId({ type: "numeric" });

        if (identityType === "BVN") {
            await this.identityResolution.resolveOrCreate(IdentityIdType.BVN, generatedValue, userId);
            await this.prisma.user.update({
                where: { id: userId },
                data: {
                    isBvnVerified: true,
                    bvn: generatedValue,
                },
            });
        } else {
            await this.identityResolution.resolveOrCreate(IdentityIdType.NIN, generatedValue, userId);
            await this.prisma.user.update({
                where: { id: userId },
                data: {
                    isNinVerified: true,
                    nin: generatedValue,
                },
            });
        }

        await this.kycStateMachine.transition(userId, identityType, "APPROVED", {
            providerRef: "DEV_BYPASS",
            providerRawResponse: { bypass: true },
        });
    }

    private async finalizeIdentityVerification(userId: number, identityType: "BVN" | "NIN"): Promise<void> {
        await this.tierService.syncTierAndCache(userId);
        this.logger.log(`[KYC][${identityType}] Tier/profile cache refreshed for user ${userId}`);

        try {
            await this.cryptoAccountQueueProducer.enqueue(userId);
            this.logger.log(`[KYC][${identityType}] Crypto account enqueue successful for user ${userId}`);
        } catch (error) {
            this.logger.error(`Error in sub account setup: ${error instanceof Error ? error.message : String(error)}`);
        }

        try {
            const user = await this.prisma.user.findUnique({
                where: { id: userId },
                select: { email: true, firstName: true },
            });

            if (user?.email && emailTemplateConfig.document_approved) {
                await this.emailService.sendMailWithTemplate({
                    from: { address: mailConfig.senderMail },
                    to: [{ email_address: { address: user.email } }],
                    template_key: emailTemplateConfig.document_approved,
                    merge_info: {
                        first_name: user.firstName || "User",
                        document_type: identityType,
                        company_name: COMPANY_NAME,
                        rejection_reason: "",
                        status: "Approved",
                    },
                });
                this.logger.log(`[KYC][${identityType}] Approval email sent to user ${userId}`);
            } else {
                this.logger.warn(`[KYC][${identityType}] Skipped approval email for user ${userId}: missing email or template`);
            }
        } catch (error) {
            this.logger.error(`[KYC][${identityType}] Failed to send approval email for user ${userId}: ${error instanceof Error ? error.message : String(error)}`);
        }

        try {
            await this.notificationDispatcher.notify({
                userId,
                title: "Identity Verified",
                body: `Your ${identityType} verification has been approved.`,
                category: "security",
                enablePush: true,
            });
            this.wsGateway.notifyProfileUpdate(userId);
            this.logger.log(`[KYC][${identityType}] In-app notification sent to user ${userId}`);
        } catch (error) {
            this.logger.error(`[KYC][${identityType}] Failed to send notification for user ${userId}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async bvnVerification(user: User, dto: BvnVerificationDto) {
        const maskedBvn = this.maskSensitiveId(dto.bvn);
        this.logger.log(`[KYC][BVN] Verification initiated for user ${user.id} (bvn=${maskedBvn})`);

        if (user.isBvnVerified) {
            this.logger.warn(`[KYC][BVN] Duplicate verification attempt for user ${user.id}`);
            throw new DuplicateBvnVerificationException(
                "Bvn verification already completed",
                HttpStatus.BAD_REQUEST
            );
        }

        const bvnInUseByAnother = await this.prisma.user.findFirst({
            where: { id: { not: user.id }, bvn: dto.bvn },
        });

        if (bvnInUseByAnother) {
            this.logger.warn(`[KYC][BVN] BVN already in use (user=${user.id}, bvn=${maskedBvn})`);
            throw new VerificationGenericException(
                "This BVN is already linked to another account. If this is your BVN, please contact support for assistance.",
                HttpStatus.CONFLICT
            );
        }

        this.ensureIdentityProfilePresent(user, "BVN");

        this.logger.debug(`[KYC][BVN] Calling Dojah verification for user ${user.id}`);
        const result = await this.dojahService.verifyBvn({
            bvn: dto.bvn,
        });
        this.logger.log(`[KYC][BVN] Dojah verification response received for user ${user.id}`);

        // SECURITY: Block test BVN bypass in production
        if (dto.bvn === "22222222222") {
            if (isProdEnvironment) {
                this.logger.warn(`[SECURITY] Blocked test BVN bypass attempt for user ${user.id}`);
                throw new VerificationGenericException(
                    "Invalid BVN number",
                    HttpStatus.BAD_REQUEST
                );
            }
            // Development only - log the bypass usage
            this.logger.warn(`[SECURITY][DEV-ONLY] Test BVN bypass used for user ${user.id}`);
            await this.processDevIdentityBypass(user.id, "BVN");
        } else {
            const identityMatchOutcome = await this.rejectOnIdentityMismatch(user, result, "BVN");
            if (identityMatchOutcome === "PENDING_REVIEW") {
                return buildResponse({
                    message: "BVN submitted for manual review. An admin will review your details shortly.",
                });
            }
            await this.identityResolution.resolveOrCreate(IdentityIdType.BVN, dto.bvn, user.id, {
                firstName: result.data.entity.first_name,
                lastName: result.data.entity.last_name,
                dateOfBirth: result.data.entity.date_of_birth,
            });
            await this.updateIdentityWithConflictGuard(user.id, "BVN", {
                isBvnVerified: true,
                bvn: dto.bvn,
                bvnRegisteredPhone: result.data.entity.phone_number1,
            });
            // Audit trail for successful BVN verification
            await this.kycStateMachine.transition(user.id, "BVN", "APPROVED", {
                providerRef: result?.data?.entity?.reference_id,
                providerRawResponse: result?.data,
            });
        }
        this.logger.log(`[KYC][BVN] Verification persisted for user ${user.id}`);

        await this.finalizeIdentityVerification(user.id, "BVN");

        return buildResponse({
            message: "Bvn Verification successfully",
        });
    }

    async ninVerification(user: User, dto: NinVerificationDto) {
        const maskedNin = this.maskSensitiveId(dto.nin);
        this.logger.log(`[KYC][NIN] Verification initiated for user ${user.id} (nin=${maskedNin})`);

        if (user.isNinVerified) {
            this.logger.warn(`[KYC][NIN] Duplicate verification attempt for user ${user.id}`);
            throw new DuplicateVerificationException(
                "NIN verification already completed",
                HttpStatus.BAD_REQUEST
            );
        }

        const ninInUseByAnother = await this.prisma.user.findFirst({
            where: { id: { not: user.id }, nin: dto.nin },
        });

        if (ninInUseByAnother) {
            this.logger.warn(`[KYC][NIN] NIN already in use (user=${user.id}, nin=${maskedNin})`);
            throw new VerificationGenericException(
                "This NIN is already linked to another account. If this is your NIN, please contact support for assistance.",
                HttpStatus.CONFLICT
            );
        }

        this.ensureIdentityProfilePresent(user, "NIN");

        this.logger.debug(`[KYC][NIN] Calling Dojah verification for user ${user.id}`);
        const result = await this.dojahService.verifyNin({
            nin: dto.nin,
        });
        this.logger.log(`[KYC][NIN] Dojah verification response received for user ${user.id}`);

        // SECURITY: Block test NIN bypass in production
        if (dto.nin === "00000000001") {
            if (isProdEnvironment) {
                this.logger.warn(`[SECURITY] Blocked test NIN bypass attempt for user ${user.id}`);
                throw new VerificationGenericException(
                    "Invalid NIN number",
                    HttpStatus.BAD_REQUEST
                );
            }
            // Development only - log the bypass usage
            this.logger.warn(`[SECURITY][DEV-ONLY] Test NIN bypass used for user ${user.id}`);
            await this.processDevIdentityBypass(user.id, "NIN");
        } else {
            const identityMatchOutcome = await this.rejectOnIdentityMismatch(user, result, "NIN");
            if (identityMatchOutcome === "PENDING_REVIEW") {
                return buildResponse({
                    message: "NIN submitted for manual review. An admin will review your details shortly.",
                });
            }
            await this.identityResolution.resolveOrCreate(IdentityIdType.NIN, dto.nin, user.id, {
                firstName: result.data.entity.first_name,
                lastName: result.data.entity.last_name,
                dateOfBirth: result.data.entity.date_of_birth,
            });
            await this.updateIdentityWithConflictGuard(user.id, "NIN", {
                isNinVerified: true,
                nin: dto.nin,
                ninRegisteredPhone: result.data.entity.phone_number,
            });
            // Audit trail for successful NIN verification
            await this.kycStateMachine.transition(user.id, "NIN", "APPROVED", {
                providerRef: result?.data?.entity?.reference_id,
                providerRawResponse: result?.data,
            });
        }
        this.logger.log(`[KYC][NIN] Verification persisted for user ${user.id}`);

        await this.finalizeIdentityVerification(user.id, "NIN");

        return buildResponse({
            message: "NIN Verification successfully",
        });
    }

    async onboardIndividual(user: User, dto: OnboardIndividualDto) {
        // Check if user already has profile info set
        if (user.firstName && user.lastName && user.dateOfBirth) {
            throw new VerificationGenericException(
                "User profile already completed",
                HttpStatus.BAD_REQUEST
            );
        }

        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                firstName: dto.firstName,
                lastName: dto.lastName,
                dateOfBirth: new Date(dto.dateOfBirth),
            },
        });

        try {
            await this.cryptoAccountQueueProducer.enqueue(user.id);
        } catch (error) {
            this.logger.error(`Error in sub account setup: ${error instanceof Error ? error.message : String(error)}`);
        }

        return buildResponse({
            message: "Profile updated successfully",
        });
    }

    async documentVerification(
        user: User,
        files: DocumentVerificationFileInterface,
        dto: DocumentVerificationDto
    ) {
        const logger = new Logger("DocumentVerification");

        if (user.isDocumentVerified) {
            throw new VerificationGenericException(
                "Document has already been verified",
                HttpStatus.BAD_REQUEST
            );
        }

        // Check if document is already pending review
        const existingDocument = await this.prisma.userDocument.findUnique({
            where: { userId: user.id },
            select: { verificationStatus: true },
        });
        if (existingDocument?.verificationStatus === DocumentVerificationStatus.PENDING) {
            throw new VerificationGenericException(
                "Document verification is pending review",
                HttpStatus.BAD_REQUEST
            );
        }

        // Upload document images
        const documentImage1Promise = this.uploadAsFile(files.documentImage1);
        const documentImage2Promise = files.documentImage2
            ? this.uploadAsFile(files.documentImage2)
            : Promise.resolve(null);

        const [documentImage1, documentImage2] = await Promise.all([
            documentImage1Promise,
            documentImage2Promise,
        ]);

        // Attempt to verify document with Dojah
        let isDocumentValid = false;
        let nameMatches = false;
        let dojahParsed: any = null;
        let dojahRawResponse: string | null = null;

        try {
            // Use the new verifyDocumentWithNameMatch method
            const verificationResult = await this.dojahService.verifyDocumentWithNameMatch(
                {
                    inputType: "url",
                    imageFrontSide: documentImage1.url,
                    ...(documentImage2 && { imageBackSide: documentImage2.url }),
                },
                user.firstName,
                user.lastName
            );

            isDocumentValid = verificationResult.isValid;
            nameMatches = verificationResult.nameMatches;
            dojahParsed = verificationResult.parsed;
            dojahRawResponse = JSON.stringify(verificationResult);

            // Check if document is expired
            if (isDocumentValid && this.isDocumentExpired(dojahParsed?.expiryDate)) {
                logger.warn(`Document for user ${user.id} is expired: ${dojahParsed?.expiryDate}`);
                isDocumentValid = false;
                dojahParsed.reason = "Document has expired";
            }

            logger.log(
                `Document analysis for user ${user.id}: ` +
                `valid=${isDocumentValid}, nameMatches=${nameMatches}, ` +
                `docType=${dojahParsed?.documentType || "unknown"}, ` +
                `expiryDate=${dojahParsed?.expiryDate || "unknown"}`
            );

            // Document must be valid AND name must match for auto-approval
            if (!isDocumentValid) {
                logger.warn(`Document for user ${user.id} failed validation: ${dojahParsed?.reason}`);
            }
            if (!nameMatches) {
                logger.warn(
                    `Name mismatch for user ${user.id}: ` +
                    `expected "${user.firstName} ${user.lastName}", ` +
                    `got "${dojahParsed?.firstName || ""} ${dojahParsed?.lastName || ""}"`
                );
            }
        } catch (error) {
            // If Dojah fails (API error, low balance, timeout, etc.), fall back to pending review
            logger.warn(
                `Dojah document analysis failed for user ${user.id}, falling back to manual review: ${error.message}`
            );
            isDocumentValid = false;
            nameMatches = false;
        }

        // Determine verification status:
        // - VERIFIED: Document is valid AND name matches
        // - PENDING: Document is invalid, name doesn't match, or Dojah call failed
        const shouldAutoApprove = isDocumentValid && nameMatches;
        const verificationStatus = shouldAutoApprove
            ? DocumentVerificationStatus.VERIFIED
            : DocumentVerificationStatus.PENDING;

        await this.prisma.$transaction(
            async (tx) => {
                await tx.userDocument.upsert({
                    where: { userId: user.id },
                    update: {
                        type: dto.documentType,
                        country: dto.country,
                        documentNumber: dto.documentNumber,
                        documentImageUrl: documentImage1.url,
                        documentImageFieldId: documentImage1.fileId,
                        ...(documentImage2 && {
                            documentImageUrl2: documentImage2.url,
                            documentImage2FieldId: documentImage2.fileId,
                        }),
                        // Dojah verification fields
                        verificationStatus,
                        dojahVerified: isDocumentValid,
                        dojahDocumentType: dojahParsed?.documentType || null,
                        dojahCountryCode: dojahParsed?.countryCode || null,
                        dojahExtractedFirstName: dojahParsed?.firstName || null,
                        dojahExtractedLastName: dojahParsed?.lastName || null,
                        dojahExtractedDob: dojahParsed?.dateOfBirth || null,
                        dojahExtractedDocNumber: dojahParsed?.documentNumber || null,
                        dojahExtractedExpiryDate: dojahParsed?.expiryDate || null,
                        dojahNameMatches: nameMatches,
                        dojahVerifiedAt: new Date(),
                        dojahRawResponse,
                        updatedAt: new Date(),
                    },
                    create: {
                        userId: user.id,
                        type: dto.documentType,
                        country: dto.country,
                        documentNumber: dto.documentNumber,
                        documentImageUrl: documentImage1.url,
                        documentImageFieldId: documentImage1.fileId,
                        ...(documentImage2 && {
                            documentImageUrl2: documentImage2.url,
                            documentImage2FieldId: documentImage2.fileId,
                        }),
                        // Dojah verification fields
                        verificationStatus,
                        dojahVerified: isDocumentValid,
                        dojahDocumentType: dojahParsed?.documentType || null,
                        dojahCountryCode: dojahParsed?.countryCode || null,
                        dojahExtractedFirstName: dojahParsed?.firstName || null,
                        dojahExtractedLastName: dojahParsed?.lastName || null,
                        dojahExtractedDob: dojahParsed?.dateOfBirth || null,
                        dojahExtractedDocNumber: dojahParsed?.documentNumber || null,
                        dojahExtractedExpiryDate: dojahParsed?.expiryDate || null,
                        dojahNameMatches: nameMatches,
                        dojahVerifiedAt: new Date(),
                        dojahRawResponse,
                    },
                });

                await tx.user.update({
                    where: { id: user.id },
                    data: {
                        isDocumentVerified: shouldAutoApprove,
                        documentVerificationStatus: verificationStatus,
                    },
                });
            },
            { timeout: 30000 }
        );

        // Audit trail for document verification
        await this.kycStateMachine.transition(
            user.id,
            "DOCUMENT",
            shouldAutoApprove ? "APPROVED" : "PENDING",
            {
                providerRef: dojahParsed?.documentNumber || null,
                providerRawResponse: dojahParsed,
                reviewNote: shouldAutoApprove
                    ? "Auto-approved: document valid and name matches"
                    : `Manual review needed: valid=${isDocumentValid}, nameMatches=${nameMatches}`,
            }
        );

        // Sync tier & flush profile cache after document verification
        await this.tierService.syncTierAndCache(user.id);

        if (shouldAutoApprove) {
            this.sendDocumentAutoApprovalNotifications(user.id, user.email, user.firstName, "Identity Document", logger);
            return buildResponse({
                message: "Document verified successfully",
            });
        }

        // In-app notification for pending review
        await this.notificationDispatcher.notify({
            userId: user.id,
            title: "Document Submitted",
            body: "Your identity document has been submitted for review. We'll notify you once it's processed.",
            category: "security",
        });

        return buildResponse({
            message: "Document submitted for review. You will be notified once verification is complete.",
        });
    }

    private async uploadDocumentImage(
        file: string
    ): Promise<UploadResponse | UploadApiResponse> {
        const date = Date.now();
        const body = Buffer.from(file, "base64");

        return await this.uploadService.uploadCompressedImage({
            dir: storageDirConfig.document,
            name: `documet-image-${date}-${generateRandomNum(5)}`,
            format: "webp",
            body: body,
            quality: 100,
            width: 989,
        });
    }

    async uploadAsFile(file?: Express.Multer.File[]) {
        if (!file?.length || !file[0]?.buffer) {
            throw new RequiredFilesMissing();
        }

        const date = Date.now();
        const body = file[0].buffer;
        const mimetype = file[0].mimetype?.toLowerCase() || "";

        // PDFs cannot be processed by Sharp — upload directly without compression
        const isPdf =
            mimetype === "application/pdf" ||
            file[0].originalname?.toLowerCase().endsWith(".pdf");

        if (isPdf) {
            const result = await this.uploadService.uploadImage({
                dir: storageDirConfig.document,
                name: `document-${date}-${generateRandomNum(5)}.pdf`,
                format: "png",
                body: body,
            });
            return result;
        }

        const result = await this.uploadService.uploadCompressedImage({
            dir: storageDirConfig.document,
            name: `document-${date}-${generateRandomNum(5)}`,
            format: "webp",
            body: body,
            quality: 100,
            width: 989,
        });

        return result;
    }

    /**
     * Upload a base64 image to storage and return the URL
     * Strips data:image prefix if present
     */
    private async uploadBase64Image(base64String: string): Promise<{
        url: string;
        fileId: string;
    }> {
        // Strip data:image prefix if present (e.g., "data:image/jpeg;base64,")
        const cleanBase64 = base64String.replace(/^data:image\/\w+;base64,/, "");
        const date = Date.now();
        const body = Buffer.from(cleanBase64, "base64");

        const result = await this.uploadService.uploadCompressedImage({
            dir: storageDirConfig.document,
            name: `document-${date}-${generateRandomNum(5)}`,
            format: "webp",
            body: body,
            quality: 100,
            width: 989,
        });

        // Handle both Cloudinary (secure_url/public_id) and ImageKit (url/fileId) responses
        const url = "secure_url" in result ? result.secure_url : result.url;
        const fileId = "public_id" in result ? result.public_id : result.fileId;

        return { url, fileId };
    }

    /**
     * Preview/pre-validate document using Dojah OCR
     * Does NOT save anything to database - just returns extracted data
     * Used for real-time validation as user uploads documents
     */
    async previewDocument(user: User, dto: DocumentPreviewDto) {
        const logger = new Logger("DocumentPreview");

        // Strip data:image prefix for Dojah API
        const cleanFrontBase64 = dto.imageFrontBase64.replace(/^data:image\/\w+;base64,/, "");
        const cleanBackBase64 = dto.imageBackBase64
            ? dto.imageBackBase64.replace(/^data:image\/\w+;base64,/, "")
            : undefined;

        logger.log(`Document preview starting for user ${user.id}`, {
            frontImageSize: dto.imageFrontBase64?.length || 0,
            backImageSize: dto.imageBackBase64?.length || 0,
        });

        const startTime = Date.now();

        try {
            const result = await this.dojahService.analyzeDocument({
                inputType: "base64",
                imageFrontSide: cleanFrontBase64,
                ...(cleanBackBase64 && { imageBackSide: cleanBackBase64 }),
            });

            const parsed = result.parsed;
            const durationMs = Date.now() - startTime;

            logger.log(
                `Document preview completed in ${durationMs}ms for user ${user.id}: ` +
                `valid=${parsed.isValid}, type=${parsed.documentType}, reason=${parsed.reason}`
            );

            // If document failed validation, log more details
            if (!parsed.isValid) {
                logger.warn(`Document preview INVALID for user ${user.id}:`, {
                    reason: parsed.reason,
                    documentType: parsed.documentType,
                    country: parsed.country,
                    hasPortrait: parsed.hasPortrait,
                    hasFrontSide: parsed.hasFrontSide,
                    hasBackSide: parsed.hasBackSide,
                    extractedFields: {
                        firstName: !!parsed.firstName,
                        lastName: !!parsed.lastName,
                        documentNumber: !!parsed.documentNumber,
                        dateOfBirth: !!parsed.dateOfBirth,
                    },
                });
            }

            // Determine if OCR extracted enough text to allow submission for manual review
            const canProceedForReview = parsed.hasExtractedText;

            let message: string;
            if (parsed.isValid) {
                message = "Document analyzed successfully";
            } else if (canProceedForReview) {
                message = "Document needs review but key details were extracted. You can proceed to submit.";
            } else {
                message = this.mapDojahReasonToUserMessage(parsed.reason);
            }

            // Return extracted data for user verification
            return {
                success: true,
                message,
                data: {
                    isValid: parsed.isValid,
                    reason: parsed.reason,
                    documentType: parsed.documentType,
                    country: parsed.country,
                    // Extracted personal info
                    firstName: parsed.firstName,
                    lastName: parsed.lastName,
                    givenNames: parsed.givenNames,
                    documentNumber: parsed.documentNumber,
                    dateOfBirth: parsed.dateOfBirth,
                    expiryDate: parsed.expiryDate,
                    issueDate: parsed.issueDate,
                    sex: parsed.sex,
                    nationality: parsed.nationality,
                    // Image quality indicators
                    hasPortrait: parsed.hasPortrait,
                    hasFrontSide: parsed.hasFrontSide,
                    hasBackSide: parsed.hasBackSide,
                    // OCR text extraction indicator (independent of image segmentation)
                    hasExtractedText: parsed.hasExtractedText,
                },
            };
        } catch (error) {
            const durationMs = Date.now() - startTime;
            logger.error(`Document preview failed in ${durationMs}ms for user ${user.id}`, {
                errorName: error.name,
                errorMessage: error.message,
            });

            const userMessage = this.mapDojahErrorToUserMessage({
                name: error.name,
                message: error.message,
                status: error.status,
            });

            return {
                success: false,
                message: userMessage,
                data: null,
            };
        }
    }

    /**
     * Map Dojah reason codes to user-friendly messages
     */
    private mapDojahReasonToUserMessage(reason?: string): string {
        if (!reason) return "Document analysis completed";

        const upperReason = reason.toUpperCase();

        if (upperReason === "NOT_VALID" || upperReason === "INVALID") {
            return "Document could not be verified. Please ensure the image is clear, all text is readable, and the document is a valid government-issued ID.";
        }
        if (upperReason.includes("BLUR") || upperReason.includes("UNCLEAR")) {
            return "Document image is unclear. Please take a clearer photo with good lighting.";
        }
        if (upperReason.includes("EXPIRED")) {
            return "Document appears to be expired. Please upload a valid, unexpired document.";
        }
        if (upperReason.includes("NOT_SUPPORTED") || upperReason.includes("UNSUPPORTED")) {
            return "This document type is not supported. Please upload a valid passport, driver's license, or national ID.";
        }

        return reason;
    }

    /** Map Dojah/client document type strings to internal DocumentType enum. */
    private mapDojahToDocumentType(dojahDocTypeRaw?: string, fallbackDocType?: string): DocumentType {
        const dojahDocType = dojahDocTypeRaw?.toLowerCase();
        if (dojahDocType?.includes("passport")) return DocumentType.INTERNATIONAL_PASSPORT;
        if (dojahDocType?.includes("driver") || dojahDocType?.includes("license")) return DocumentType.DRIVER_LICENSE;

        const providedType = fallbackDocType?.toLowerCase();
        if (providedType?.includes("passport")) return DocumentType.INTERNATIONAL_PASSPORT;
        if (providedType?.includes("driver") || providedType?.includes("license")) return DocumentType.DRIVER_LICENSE;

        return DocumentType.NIN;
    }

    /** Persist Dojah widget response + update user status + audit trail. */
    private async persistWidgetVerification(
        userId: number,
        documentType: DocumentType,
        dto: DojahWidgetVerificationDto,
        serverVerified: boolean,
        finalStatus: DocumentVerificationStatus,
        serverVerificationData: any,
    ) {
        const rawResponse = JSON.stringify({
            verificationId: dto.verificationId,
            referenceId: dto.referenceId,
            verificationType: dto.verificationType,
            idData: dto.idData,
            liveness: dto.liveness,
            selfie: dto.selfie,
            faceMatch: dto.faceMatch,
            verifiedViaWidget: true,
            serverVerification: serverVerificationData,
        });

        const dojahFields = {
            type: documentType,
            country: Country.NIGERIA,
            documentNumber: dto.idData?.document_number || "",
            verificationStatus: finalStatus,
            dojahVerified: serverVerified,
            dojahDocumentType: dto.idData?.document_type || null,
            dojahCountryCode: dto.idData?.country || null,
            dojahExtractedFirstName: dto.idData?.first_name || null,
            dojahExtractedLastName: dto.idData?.last_name || null,
            dojahExtractedDob: dto.idData?.date_of_birth || null,
            dojahExtractedDocNumber: dto.idData?.document_number || null,
            dojahExtractedExpiryDate: dto.idData?.expiry_date || null,
            dojahNameMatches: serverVerified,
            dojahVerifiedAt: new Date(),
            dojahRawResponse: rawResponse,
        };

        await this.prisma.userDocument.upsert({
            where: { userId },
            update: { ...dojahFields, updatedAt: new Date() },
            create: {
                userId,
                ...dojahFields,
                documentImageUrl: "dojah-widget-verified",
                documentImageFieldId: `dojah-widget-${dto.verificationId || Date.now()}`,
            },
        });

        await this.prisma.user.update({
            where: { id: userId },
            data: {
                isDocumentVerified: serverVerified,
                documentVerificationStatus: finalStatus,
            },
        });

        await this.kycStateMachine.transition(
            userId,
            "DOCUMENT",
            serverVerified ? "APPROVED" : "PENDING",
            {
                providerRef: dto.verificationId || dto.referenceId,
                providerRawResponse: { widget: true, serverVerified, serverVerificationData },
                reviewNote: serverVerified
                    ? "Server-side confirmed via Dojah widget"
                    : "Widget submitted but server-side confirmation failed — pending manual review",
            }
        );
    }

    /** Server-side verification of Dojah widget result. Never throws — returns verified=false on failure. */
    private async verifyDojahServerSide(
        verificationId: string | undefined,
        userId: number,
        logger: Logger,
    ): Promise<{ serverVerified: boolean; serverVerificationData: any }> {
        if (!verificationId) {
            logger.warn(`No verificationId provided for user ${userId}, cannot perform server-side check`);
            return { serverVerified: false, serverVerificationData: null };
        }
        try {
            const serverResult = await this.dojahService.getVerificationResult(verificationId);
            logger.log(`Server-side verification for user ${userId}: verified=${serverResult.verified}, status=${serverResult.status}`);
            return { serverVerified: serverResult.verified, serverVerificationData: serverResult.data };
        } catch (error) {
            logger.warn(`Server-side verification check failed for user ${userId}, falling back to manual review: ${error.message}`);
            return { serverVerified: false, serverVerificationData: null };
        }
    }

    /** Build the API response after Dojah widget verification completes. */
    private async buildWidgetVerificationResponse(
        serverVerified: boolean,
        userId: number,
        documentType: DocumentType,
        dto: DojahWidgetVerificationDto,
        updatedUser: any,
        logger: Logger,
    ) {
        if (serverVerified) {
            logger.log(`Dojah widget verification completed successfully for user ${userId}, new tier: ${updatedUser.tier ?? 0}`);
            return buildResponse({
                message: "Document verified successfully",
                data: {
                    verified: true,
                    documentType,
                    firstName: dto.idData?.first_name,
                    lastName: dto.idData?.last_name,
                    documentNumber: dto.idData?.document_number,
                    tier: updatedUser.tier ?? 0,
                    canTransact: (updatedUser.tier ?? 0) > 0,
                },
            });
        }

        logger.warn(`Dojah widget verification for user ${userId} requires manual review (server-side check failed)`);
        await this.notificationDispatcher.notify({
            userId,
            title: "Document Submitted",
            body: "Your identity document has been submitted for review. We'll notify you once it's processed.",
            category: "security",
        });
        return buildResponse({
            message: "Document submitted for review. You will be notified once verification is complete.",
            data: { verified: false, documentType, pendingReview: true },
        });
    }

    /**
     * Submit Dojah Widget verification result
     * Receives verification data from Dojah Widget and saves to database
     */
    async submitDojahWidgetVerification(user: User, dto: DojahWidgetVerificationDto) {
        const logger = new Logger("DojahWidgetVerification");

        logger.log(`Dojah widget verification submission for user ${user.id}`, {
            verificationId: dto.verificationId,
            referenceId: dto.referenceId,
            verificationType: dto.verificationType,
            hasIdData: !!dto.idData,
            hasLiveness: !!dto.liveness,
            hasSelfie: !!dto.selfie,
            hasFaceMatch: !!dto.faceMatch,
        });

        try {
            // Check if already verified
            if (user.isDocumentVerified) {
                return buildResponse({
                    message: "Document has already been verified",
                    data: { verified: true },
                });
            }

            // Map Dojah document type to internal document type
            const documentType = this.mapDojahToDocumentType(
                dto.idData?.document_type,
                dto.documentType,
            );

            // SECURITY: Server-side verification of widget result
            // Do NOT trust the client-submitted verification data alone
            const { serverVerified, serverVerificationData } =
                await this.verifyDojahServerSide(dto.verificationId, user.id, logger);

            const finalStatus = serverVerified
                ? DocumentVerificationStatus.VERIFIED
                : DocumentVerificationStatus.PENDING;

            // Persist widget verification data and update user status
            await this.persistWidgetVerification(
                user.id, documentType, dto, serverVerified, finalStatus, serverVerificationData,
            );

            // Sync tier & flush cache for both branches — flags were written above
            const updatedUser = await this.tierService.syncTierAndCache(user.id);

            if (serverVerified) {
                this.sendDocumentAutoApprovalNotifications(user.id, user.email, user.firstName, "Identity Document", logger);
            }

            return this.buildWidgetVerificationResponse(
                serverVerified, user.id, documentType, dto, updatedUser, logger,
            );
        } catch (error) {
            logger.error(`Dojah widget verification failed for user ${user.id}`, {
                error: error.message,
                stack: error.stack,
            });

            // Re-throw so the controller returns proper HTTP error code
            throw error;
        }
    }

    /**
     * Document verification optimized for Dojah integration
     * Accepts base64-encoded images directly - no FormData needed
     * Stores images for manual review while using Dojah for auto-verification
     */
    async documentVerificationBase64(
        user: User,
        dto: DocumentVerificationBase64Dto
    ) {
        const logger = new Logger("DocumentVerificationBase64");

        if (user.isDocumentVerified) {
            throw new VerificationGenericException(
                "Document has already been verified",
                HttpStatus.BAD_REQUEST
            );
        }

        // Check if document is already pending review
        const existingDocument = await this.prisma.userDocument.findUnique({
            where: { userId: user.id },
            select: { verificationStatus: true },
        });
        if (existingDocument?.verificationStatus === DocumentVerificationStatus.PENDING) {
            throw new VerificationGenericException(
                "Document verification is pending review",
                HttpStatus.BAD_REQUEST
            );
        }

        // Strip data:image prefix for Dojah API (required per Dojah docs)
        const cleanFrontBase64 = dto.imageFrontBase64.replace(/^data:image\/\w+;base64,/, "");
        const cleanBackBase64 = dto.imageBackBase64
            ? dto.imageBackBase64.replace(/^data:image\/\w+;base64,/, "")
            : undefined;

        // Log payload sizes for debugging
        logger.log(`Document verification starting for user ${user.id}`, {
            frontImageSize: dto.imageFrontBase64?.length || 0,
            backImageSize: dto.imageBackBase64?.length || 0,
            documentType: dto.documentType,
            country: dto.country,
        });

        const startTime = Date.now();

        // Upload images to storage (for manual review if needed) and verify with Dojah in parallel
        const [documentImage1, documentImage2, dojahResult] = await Promise.all([
            this.uploadBase64Image(dto.imageFrontBase64),
            dto.imageBackBase64 ? this.uploadBase64Image(dto.imageBackBase64) : Promise.resolve(null),
            this.callDojahDocumentVerification(cleanFrontBase64, cleanBackBase64, user, dto, startTime, logger),
        ]);

        let { isValid: isDocumentValid, nameMatches, parsed: dojahParsed, raw: dojahRawResponse, error: dojahError } = dojahResult;

        // If Dojah failed with an error, throw it to the frontend with a user-friendly message
        if (!dojahResult.success && dojahError) {
            const userMessage = this.mapDojahErrorToUserMessage(dojahError);
            throw new VerificationGenericException(
                userMessage,
                dojahError.status || HttpStatus.BAD_REQUEST
            );
        }

        isDocumentValid = this.applyDojahPostValidation(isDocumentValid, dojahParsed, user.id, logger);

        // Auto-approve if document is valid; otherwise save as PENDING for manual review
        // Name matching is informational only, logged for review if needed
        const shouldAutoApprove = isDocumentValid;
        const verificationStatus = shouldAutoApprove
            ? DocumentVerificationStatus.VERIFIED
            : DocumentVerificationStatus.PENDING;

        await this.prisma.$transaction(
            async (tx) => {
                await tx.userDocument.upsert({
                    where: { userId: user.id },
                    update: {
                        type: dto.documentType,
                        country: dto.country,
                        documentNumber: dto.documentNumber,
                        documentImageUrl: documentImage1.url,
                        documentImageFieldId: documentImage1.fileId,
                        ...(documentImage2 && {
                            documentImageUrl2: documentImage2.url,
                            documentImage2FieldId: documentImage2.fileId,
                        }),
                        // Dojah verification fields
                        verificationStatus,
                        dojahVerified: isDocumentValid,
                        dojahDocumentType: dojahParsed?.documentType || null,
                        dojahCountryCode: dojahParsed?.countryCode || null,
                        dojahExtractedFirstName: dojahParsed?.firstName || null,
                        dojahExtractedLastName: dojahParsed?.lastName || null,
                        dojahExtractedDob: dojahParsed?.dateOfBirth || null,
                        dojahExtractedDocNumber: dojahParsed?.documentNumber || null,
                        dojahExtractedExpiryDate: dojahParsed?.expiryDate || null,
                        dojahNameMatches: nameMatches,
                        dojahVerifiedAt: new Date(),
                        dojahRawResponse,
                        updatedAt: new Date(),
                    },
                    create: {
                        userId: user.id,
                        type: dto.documentType,
                        country: dto.country,
                        documentNumber: dto.documentNumber,
                        documentImageUrl: documentImage1.url,
                        documentImageFieldId: documentImage1.fileId,
                        ...(documentImage2 && {
                            documentImageUrl2: documentImage2.url,
                            documentImage2FieldId: documentImage2.fileId,
                        }),
                        // Dojah verification fields
                        verificationStatus,
                        dojahVerified: isDocumentValid,
                        dojahDocumentType: dojahParsed?.documentType || null,
                        dojahCountryCode: dojahParsed?.countryCode || null,
                        dojahExtractedFirstName: dojahParsed?.firstName || null,
                        dojahExtractedLastName: dojahParsed?.lastName || null,
                        dojahExtractedDob: dojahParsed?.dateOfBirth || null,
                        dojahExtractedDocNumber: dojahParsed?.documentNumber || null,
                        dojahExtractedExpiryDate: dojahParsed?.expiryDate || null,
                        dojahNameMatches: nameMatches,
                        dojahVerifiedAt: new Date(),
                        dojahRawResponse,
                    },
                });

                await tx.user.update({
                    where: { id: user.id },
                    data: {
                        isDocumentVerified: shouldAutoApprove,
                        documentVerificationStatus: verificationStatus,
                    },
                });
            },
            { timeout: 30000 }
        );

        // Audit trail for base64 document verification
        await this.kycStateMachine.transition(
            user.id,
            "DOCUMENT",
            shouldAutoApprove ? "APPROVED" : "PENDING",
            {
                providerRef: dojahParsed?.documentNumber || null,
                providerRawResponse: dojahParsed,
                reviewNote: shouldAutoApprove
                    ? "Auto-approved: document valid via base64 upload"
                    : `Manual review needed: valid=${isDocumentValid}, nameMatches=${nameMatches}`,
            }
        );

        // Sync tier & flush profile cache after base64 document verification
        await this.tierService.syncTierAndCache(user.id);

        if (shouldAutoApprove) {
            this.sendDocumentAutoApprovalNotifications(user.id, user.email, user.firstName, "Identity Document", logger);
            return buildResponse({
                message: "Document verified successfully",
            });
        }

        // In-app notification for pending review
        await this.notificationDispatcher.notify({
            userId: user.id,
            title: "Document Submitted",
            body: "Your identity document has been submitted for review. We'll notify you once it's processed.",
            category: "security",
        });

        return buildResponse({
            message: "Document verification is pending review",
        });
    }

    async updloadBusinessDocuments(
        user: User,
        files: UploadBusinessDocumentsFileInterface,
        dto: BusinessDocumentUploadDto
    ) {
        if (user.businessDocumentsUploaded && user.businessDocumentVerificationStatus !== "DECLINED") {
            throw new VerificationGenericException(
                `Document has already been uploaded and is ${user.businessDocumentVerificationStatus}`,
                HttpStatus.BAD_REQUEST
            );
        }

        const safeUpload = async (
            file: Express.Multer.File[] | undefined,
            label: string
        ) => {
            if (!file) return null;
            try {
                return await this.uploadAsFile(file);
            } catch (err) {
                this.logger.error(
                    `[BusinessDocumentsUpload][UploadPhase] File "${label}" failed for user ${user.id}: ${err?.name} - ${err?.message}`,
                    err?.stack
                );
                throw err;
            }
        };

        let cacImage: UploadResult | null = null;
        let articleImage: UploadResult | null = null;
        let boardResolutionImage: UploadResult | null = null;
        let proofOfAddressImage: UploadResult | null = null;
        let meansOfIdImage: UploadResult | null = null;

        try {
            [
                cacImage,
                articleImage,
                boardResolutionImage,
                proofOfAddressImage,
                meansOfIdImage,
            ] = await Promise.all([
                safeUpload(files.cacImage, "cacImage"),
                safeUpload(files.articleOfAssociationImage, "articleOfAssociationImage"),
                safeUpload(files.boardResolutionAuthorizedAcctOpeningImage, "boardResolutionImage"),
                safeUpload(files.proofOfAddressForBeneficialOwner, "proofOfAddress"),
                safeUpload(files.meansOfIdentificationForBeneficialOwner, "meansOfId"),
            ]);
        } catch (error) {
            this.logger.error(
                `[BusinessDocumentsUpload][UploadPhase] Failed for user ${user.id} | ${error?.name}: ${error?.message}`,
                error?.stack
            );
            throw error;
        }

        try {
            await this.prisma.$transaction(
                async (tx) => {
                    await tx.businessDocument.upsert({
                        where: { userId: user.id },
                        update: {},
                        create: {
                            userId: user.id,
                            cacDocumentNumber: dto.cacDocumentNumber,
                            cacImageUrl: cacImage?.url || null,
                            cacImageUrlFieldId: cacImage?.fileId || null,
                            cacImageFileName: cacImage?.url
                                ? generateFileName(
                                    DocumentMetaMap.cacImage,
                                    user.id,
                                    files.cacImage?.[0]?.originalname
                                )
                                : null,
                            articleOfAssociationNumber:
                                dto.articleOfAssociationNumber || null,
                            articleOfAssociationImageUrl:
                                articleImage?.url || null,
                            articleOfAssociationImageUrlFieldId:
                                articleImage?.fileId || null,
                            articleOfAssociationFileName: articleImage?.url
                                ? generateFileName(
                                    DocumentMetaMap.articleOfAssociationImage,
                                    user.id,
                                    files.articleOfAssociationImage?.[0]
                                        ?.originalname
                                )
                                : null,
                            boardResolutionAuthorizedAcctOpeningImageUrl:
                                boardResolutionImage?.url || null,
                            boardResolutionAuthorizedAcctOpeningImageUrlFieldId:
                                boardResolutionImage?.fileId || null,
                            boardResolutionAuthorizedAcctOpeningFileName:
                                boardResolutionImage?.url
                                    ? generateFileName(
                                        DocumentMetaMap.boardResolutionAuthorizedAcctOpeningImage,
                                        user.id,
                                        files
                                            .boardResolutionAuthorizedAcctOpeningImage?.[0]
                                            ?.originalname
                                    )
                                    : null,
                            meansOfIdentificationForBeneficialOwner:
                                meansOfIdImage?.url || null,
                            meansOfIdentificationForBeneficialOwnerImageFieldId:
                                meansOfIdImage?.fileId || null,
                            meansOfIdentificationForBeneficialOwnerFileName:
                                meansOfIdImage?.url
                                    ? generateFileName(
                                        DocumentMetaMap.meansOfIdentificationForBeneficialOwner,
                                        user.id,
                                        files
                                            .meansOfIdentificationForBeneficialOwner?.[0]
                                            ?.originalname
                                    )
                                    : null,
                            proofOfAddressForBeneficialOwner:
                                proofOfAddressImage?.url || null,
                            proofOfAddressForBeneficialOwnerImageFieldId:
                                proofOfAddressImage?.fileId || null,
                            proofOfAddressForBeneficialOwnerFileName:
                                proofOfAddressImage?.url
                                    ? generateFileName(
                                        DocumentMetaMap.proofOfAddressForBeneficialOwner,
                                        user.id,
                                        files
                                            .proofOfAddressForBeneficialOwner?.[0]
                                            ?.originalname
                                    )
                                    : null,
                        },
                    });

                    await tx.user.update({
                        where: { id: user.id },
                        data: {
                            businessDocumentsUploaded: true,
                            businessDocumentVerificationStatus:
                                DocumentVerificationStatus.PENDING,
                        },
                    });
                },
                { timeout: 30000 }
            );
        } catch (error) {
            this.logger.error(
                `[BusinessDocumentsUpload][DatabasePhase] Failed for user ${user.id} | ${error?.name}: ${error?.message} | prismaCode=${error?.code}`,
                error?.stack
            );
            throw error;
        }

        // Invalidate backend profile cache so pending status is visible immediately
        await this.redisCacheService.del(this.getProfileCacheKey(user.id));

        // In-app notification for pending review
        await this.notificationDispatcher.notify({
            userId: user.id,
            title: "Business Documents Submitted",
            body: "Your business documents have been submitted for review. We'll notify you once they're processed.",
            category: "security",
        });

        // Fire-and-forget: Run Dojah business verification in background
        // This does NOT block the user response — results are stored async
        this.runDojahBusinessVerification(user.id, dto.cacDocumentNumber, files.cacImage?.[0])
            .catch((err) => {
                this.logger.error(
                    `[BusinessDocumentsUpload][DojahVerification] Background verification failed for user ${user.id}: ${err?.message}`,
                    err?.stack
                );
            });

        return buildResponse({
            message: "Document Verification successfully",
        });
    }

    /**
     * Upload a single business document file to ImageKit.
     * Returns the uploaded URL and fileId so the frontend can collect them
     * and send them all in a single submit call.
     */
    async uploadSingleBusinessDocumentFile(
        user: User,
        file: Express.Multer.File,
        dto: UploadBusinessDocumentFileDto
    ) {
        const isValidFieldName = (fieldName: string): boolean => {
            const companyFields = new Set([
                // existing
                "cacImage",
                "articleOfAssociationImage",
                "boardResolutionAuthorizedAcctOpeningImage",
                "proofOfAddressForBeneficialOwner",
                "meansOfIdentificationForBeneficialOwner",

                // expanded company docs
                "certificateOfIncorporation",
                "applicationForRegistration",
                "memart",
                "companyUtilityBills",
                "companyAmlPolicy",
                "scumlCertificate",
                "companyOrganogram",
                "companyLicense",
                "flowsBusinessFunds",
            ]);

            if (companyFields.has(fieldName)) return true;

            // dynamic people docs
            if (/^directors\[\d+\]\.(idDocument|proofOfAddress)$/.test(fieldName))
                return true;
            if (/^shareholders\[\d+\]\.(idDocument|proofOfAddress)$/.test(fieldName))
                return true;

            return false;
        };

        if (!isValidFieldName(dto.fieldName)) {
            throw new VerificationGenericException(
                `Invalid field name: ${dto.fieldName}`,
                HttpStatus.BAD_REQUEST
            );
        }

        try {
            const result = await this.uploadAsFile([file]);
            return buildResponse({
                message: "File uploaded successfully",
                data: {
                    fieldName: dto.fieldName,
                    url: result.url,
                    fileId: result.fileId,
                    originalName: file.originalname,
                },
            });
        } catch (error) {
            this.logger.error(
                `[BusinessDocumentFile] Upload failed for user ${user.id}, field ${dto.fieldName}: ${error?.message}`,
                error?.stack
            );
            throw error;
        }
    }

    /**
     * Submit all previously-uploaded business document URLs.
     * Creates the businessDocument record and triggers Dojah verification.
     */
    async submitBusinessDocumentsFromUrls(
        user: User,
        dto: SubmitBusinessDocumentsDto
    ) {
        if (
            user.businessDocumentsUploaded &&
            user.businessDocumentVerificationStatus !== "DECLINED"
        ) {
            throw new VerificationGenericException(
                `Document has already been uploaded and is ${user.businessDocumentVerificationStatus}`,
                HttpStatus.BAD_REQUEST
            );
        }

        const { uploadedFiles } = dto;

        // cacImage is required
        if (!uploadedFiles.cacImage?.url) {
            throw new VerificationGenericException(
                "CAC image is required",
                HttpStatus.BAD_REQUEST
            );
        }

        const getField = (name: string) => uploadedFiles[name] || null;
        const getPersonField = (
            kind: "directors" | "shareholders",
            index: number,
            name: "idDocument" | "proofOfAddress"
        ) => getField(`${kind}[${index}].${name}`);

        // Pre-build upsert data outside the transaction callback to reduce its cognitive complexity.
        const updateData = {
            cacDocumentNumber: dto.cacDocumentNumber,
            ...fileFieldUpdate(getField("cacImage"), "cacImageUrl", "cacImageUrlFieldId", "cacImageFileName", DocumentMetaMap.cacImage, user.id),
            articleOfAssociationNumber: dto.articleOfAssociationNumber || null,
            ...fileFieldUpdate(getField("articleOfAssociationImage"), "articleOfAssociationImageUrl", "articleOfAssociationImageUrlFieldId", "articleOfAssociationFileName", DocumentMetaMap.articleOfAssociationImage, user.id),
            ...fileFieldUpdate(getField("boardResolutionAuthorizedAcctOpeningImage"), "boardResolutionAuthorizedAcctOpeningImageUrl", "boardResolutionAuthorizedAcctOpeningImageUrlFieldId", "boardResolutionAuthorizedAcctOpeningFileName", DocumentMetaMap.boardResolutionAuthorizedAcctOpeningImage, user.id),
            ...fileFieldUpdate(getField("meansOfIdentificationForBeneficialOwner"), "meansOfIdentificationForBeneficialOwner", "meansOfIdentificationForBeneficialOwnerImageFieldId", "meansOfIdentificationForBeneficialOwnerFileName", DocumentMetaMap.meansOfIdentificationForBeneficialOwner, user.id),
            ...fileFieldUpdate(getField("proofOfAddressForBeneficialOwner"), "proofOfAddressForBeneficialOwner", "proofOfAddressForBeneficialOwnerImageFieldId", "proofOfAddressForBeneficialOwnerFileName", DocumentMetaMap.proofOfAddressForBeneficialOwner, user.id),
            ...fileFieldUpdate(getField("certificateOfIncorporation"), "certificateOfIncorporationUrl", "certificateOfIncorporationFieldId", "certificateOfIncorporationFileName", "certificate_of_incorporation", user.id),
            ...fileFieldUpdate(getField("applicationForRegistration"), "applicationForRegistrationUrl", "applicationForRegistrationFieldId", "applicationForRegistrationFileName", "application_for_registration", user.id),
            ...fileFieldUpdate(getField("memart"), "memartUrl", "memartFieldId", "memartFileName", "memart", user.id),
            ...fileFieldUpdate(getField("companyUtilityBills"), "companyUtilityBillsUrl", "companyUtilityBillsFieldId", "companyUtilityBillsFileName", "company_utility_bills", user.id),
            ...fileFieldUpdate(getField("companyAmlPolicy"), "companyAmlPolicyUrl", "companyAmlPolicyFieldId", "companyAmlPolicyFileName", "company_aml_policy", user.id),
            ...fileFieldUpdate(getField("scumlCertificate"), "scumlCertificateUrl", "scumlCertificateFieldId", "scumlCertificateFileName", "scuml_certificate", user.id),
            ...fileFieldUpdate(getField("companyOrganogram"), "companyOrganogramUrl", "companyOrganogramFieldId", "companyOrganogramFileName", "company_organogram", user.id),
            ...fileFieldUpdate(getField("companyLicense"), "companyLicenseUrl", "companyLicenseFieldId", "companyLicenseFileName", "company_license", user.id),
            ...fileFieldUpdate(getField("flowsBusinessFunds"), "flowsBusinessFundsUrl", "flowsBusinessFundsFieldId", "flowsBusinessFundsFileName", "flows_business_funds", user.id),
            companyWebsite: dto.companyWebsite ?? null,
            companyTaxId: dto.companyTaxId ?? null,
            companyAddress: dto.companyAddress ?? null,
            natureOfBusiness: dto.natureOfBusiness ?? null,
            purposeOfTransaction: dto.purposeOfTransaction ?? null,
            purposeOfTransactionOther: dto.purposeOfTransactionOther ?? null,
        };

        const createData = {
            userId: user.id,
            cacDocumentNumber: dto.cacDocumentNumber,
            ...fileFieldCreate(getField("cacImage"), "cacImageUrl", "cacImageUrlFieldId", "cacImageFileName", DocumentMetaMap.cacImage, user.id),
            articleOfAssociationNumber: dto.articleOfAssociationNumber || null,
            ...fileFieldCreate(getField("articleOfAssociationImage"), "articleOfAssociationImageUrl", "articleOfAssociationImageUrlFieldId", "articleOfAssociationFileName", DocumentMetaMap.articleOfAssociationImage, user.id),
            ...fileFieldCreate(getField("boardResolutionAuthorizedAcctOpeningImage"), "boardResolutionAuthorizedAcctOpeningImageUrl", "boardResolutionAuthorizedAcctOpeningImageUrlFieldId", "boardResolutionAuthorizedAcctOpeningFileName", DocumentMetaMap.boardResolutionAuthorizedAcctOpeningImage, user.id),
            ...fileFieldCreate(getField("meansOfIdentificationForBeneficialOwner"), "meansOfIdentificationForBeneficialOwner", "meansOfIdentificationForBeneficialOwnerImageFieldId", "meansOfIdentificationForBeneficialOwnerFileName", DocumentMetaMap.meansOfIdentificationForBeneficialOwner, user.id),
            ...fileFieldCreate(getField("proofOfAddressForBeneficialOwner"), "proofOfAddressForBeneficialOwner", "proofOfAddressForBeneficialOwnerImageFieldId", "proofOfAddressForBeneficialOwnerFileName", DocumentMetaMap.proofOfAddressForBeneficialOwner, user.id),
            ...fileFieldCreate(getField("certificateOfIncorporation"), "certificateOfIncorporationUrl", "certificateOfIncorporationFieldId", "certificateOfIncorporationFileName", "certificate_of_incorporation", user.id),
            ...fileFieldCreate(getField("applicationForRegistration"), "applicationForRegistrationUrl", "applicationForRegistrationFieldId", "applicationForRegistrationFileName", "application_for_registration", user.id),
            ...fileFieldCreate(getField("memart"), "memartUrl", "memartFieldId", "memartFileName", "memart", user.id),
            ...fileFieldCreate(getField("companyUtilityBills"), "companyUtilityBillsUrl", "companyUtilityBillsFieldId", "companyUtilityBillsFileName", "company_utility_bills", user.id),
            ...fileFieldCreate(getField("companyAmlPolicy"), "companyAmlPolicyUrl", "companyAmlPolicyFieldId", "companyAmlPolicyFileName", "company_aml_policy", user.id),
            ...fileFieldCreate(getField("scumlCertificate"), "scumlCertificateUrl", "scumlCertificateFieldId", "scumlCertificateFileName", "scuml_certificate", user.id),
            ...fileFieldCreate(getField("companyOrganogram"), "companyOrganogramUrl", "companyOrganogramFieldId", "companyOrganogramFileName", "company_organogram", user.id),
            ...fileFieldCreate(getField("companyLicense"), "companyLicenseUrl", "companyLicenseFieldId", "companyLicenseFileName", "company_license", user.id),
            ...fileFieldCreate(getField("flowsBusinessFunds"), "flowsBusinessFundsUrl", "flowsBusinessFundsFieldId", "flowsBusinessFundsFileName", "flows_business_funds", user.id),
            companyWebsite: dto.companyWebsite ?? null,
            companyTaxId: dto.companyTaxId ?? null,
            companyAddress: dto.companyAddress ?? null,
            natureOfBusiness: dto.natureOfBusiness ?? null,
            purposeOfTransaction: dto.purposeOfTransaction ?? null,
            purposeOfTransactionOther: dto.purposeOfTransactionOther ?? null,
        };

        try {
            await this.prisma.$transaction(
                async (tx) => {
                    const businessDocument = await tx.businessDocument.upsert({
                        where: { userId: user.id },
                        update: updateData,
                        create: createData,
                    });

                    // Directors/shareholders are stored as structured rows tied to BusinessDocument
                    const directors = Array.isArray(dto.directors) ? dto.directors : [];
                    const shareholders = Array.isArray(dto.shareholders) ? dto.shareholders : [];

                    await tx.businessDirector.deleteMany({
                        where: { businessDocumentId: businessDocument.id },
                    });
                    await tx.businessShareholder.deleteMany({
                        where: { businessDocumentId: businessDocument.id },
                    });

                    if (directors.length > 0) {
                        await tx.businessDirector.createMany({
                            data: directors.map((d, i) => ({
                                businessDocumentId: businessDocument.id,
                                fullName: d.fullName,
                                nationality: d.nationality,
                                dateOfBirth: new Date(d.dateOfBirth),
                                residentialAddress: d.residentialAddress,
                                businessAddress: d.businessAddress,
                                nin: d.nin || null,
                                idDocumentUrl: getPersonField("directors", i, "idDocument")?.url || null,
                                idDocumentFieldId: getPersonField("directors", i, "idDocument")?.fileId || null,
                                idDocumentFileName: getPersonField("directors", i, "idDocument")
                                    ? generateFileName("director_id_document", user.id, getPersonField("directors", i, "idDocument")?.originalName)
                                    : null,
                                proofOfAddressUrl: getPersonField("directors", i, "proofOfAddress")?.url || null,
                                proofOfAddressFieldId: getPersonField("directors", i, "proofOfAddress")?.fileId || null,
                                proofOfAddressFileName: getPersonField("directors", i, "proofOfAddress")
                                    ? generateFileName("director_proof_of_address", user.id, getPersonField("directors", i, "proofOfAddress")?.originalName)
                                    : null,
                            })),
                        });
                    }

                    if (shareholders.length > 0) {
                        await tx.businessShareholder.createMany({
                            data: shareholders.map((s, i) => ({
                                businessDocumentId: businessDocument.id,
                                fullName: s.fullName,
                                nationality: s.nationality,
                                dateOfBirth: new Date(s.dateOfBirth),
                                residentialAddress: s.residentialAddress,
                                businessAddress: s.businessAddress,
                                nin: s.nin || null,
                                ownershipPercentage: s.ownershipPercentage,
                                idDocumentUrl: getPersonField("shareholders", i, "idDocument")?.url || null,
                                idDocumentFieldId: getPersonField("shareholders", i, "idDocument")?.fileId || null,
                                idDocumentFileName: getPersonField("shareholders", i, "idDocument")
                                    ? generateFileName("shareholder_id_document", user.id, getPersonField("shareholders", i, "idDocument")?.originalName)
                                    : null,
                                proofOfAddressUrl: getPersonField("shareholders", i, "proofOfAddress")?.url || null,
                                proofOfAddressFieldId: getPersonField("shareholders", i, "proofOfAddress")?.fileId || null,
                                proofOfAddressFileName: getPersonField("shareholders", i, "proofOfAddress")
                                    ? generateFileName("shareholder_proof_of_address", user.id, getPersonField("shareholders", i, "proofOfAddress")?.originalName)
                                    : null,
                            })),
                        });
                    }
                    

                    await tx.user.update({
                        where: { id: user.id },
                        data: {
                            businessDocumentsUploaded: true,
                            businessDocumentVerificationStatus:
                                DocumentVerificationStatus.PENDING,
                        },
                    });
                },
                { timeout: 30000 }
            );
        } catch (error) {
            this.logger.error(
                `[SubmitBusinessDocuments][DatabasePhase] Failed for user ${user.id} | ${error?.name}: ${error?.message} | prismaCode=${error?.code}`,
                error?.stack
            );
            throw error;
        }

        // Invalidate backend profile cache
        await this.redisCacheService.del(this.getProfileCacheKey(user.id));

        // In-app notification for pending review
        await this.notificationDispatcher.notify({
            userId: user.id,
            title: "Business Documents Submitted",
            body: "Your business documents have been submitted for review. We'll notify you once they're processed.",
            category: "security",
        });

        // For Dojah verification we need the CAC image buffer.
        // Since we already uploaded to ImageKit, fetch it back as base64.
        this.runDojahBusinessVerificationFromStoredDocument(
            user.id,
            dto.cacDocumentNumber,
        ).catch((err) => {
            this.logger.error(
                `[SubmitBusinessDocuments][DojahVerification] Background verification failed for user ${user.id}: ${err?.message}`,
                err?.stack
            );
        });

        return buildResponse({
            message: "Document Verification successfully",
        });
    }

    /**
     * Background Dojah verification for business documents.
     * Runs CAC lookup, TIN verification, and CAC document OCR in parallel.
     * Stores results back into BusinessDocument record.
     */
    private async runDojahBusinessVerification(
        userId: number,
        cacDocumentNumber: string,
        cacImageFile?: Express.Multer.File
    ): Promise<void> {
        try {
            // Fetch business record for TIN and business name
            const businessRecord = await this.prisma.businessRecord.findUnique({
                where: { userId },
            });

            const businessName = businessRecord?.businessName || "";
            const tin = businessRecord?.taxIdentificationNumber;

            // Convert CAC image buffer to base64 for OCR
            let cacImageBase64: string | undefined;
            if (cacImageFile?.buffer) {
                cacImageBase64 = cacImageFile.buffer.toString("base64");
            }

            this.logger.log(
                `[DojahBusinessVerification] Starting for user ${userId}: ` +
                `RC=${cacDocumentNumber}, TIN=${tin ? "provided" : "none"}, ` +
                `OCR=${cacImageBase64 ? "has image" : "no image"}, businessName=${businessName}`
            );

            const verificationResult = await this.dojahService.verifyBusinessDocuments({
                cacDocumentNumber,
                taxIdentificationNumber: tin,
                cacImageBase64,
                businessName,
            });

            // Store results in BusinessDocument
            await this.prisma.businessDocument.update({
                where: { userId },
                data: {
                    // CAC lookup results
                    cacVerified: verificationResult.cac.verified,
                    cacVerifiedAt: verificationResult.cac.verified ? new Date() : null,
                    cacCompanyName: verificationResult.cac.companyName || null,
                    cacCompanyStatus: verificationResult.cac.companyStatus || null,
                    cacRegistrationDate: verificationResult.cac.registrationDate || null,
                    cacNameMatches: verificationResult.cac.nameMatches ?? null,
                    cacRawResponse: verificationResult.cac.rawResponse || null,

                    // TIN verification results
                    tinVerified: verificationResult.tin.verified,
                    tinVerifiedAt: verificationResult.tin.verified ? new Date() : null,
                    tinTaxpayerName: verificationResult.tin.taxpayerName || null,
                    tinNameMatches: verificationResult.tin.nameMatches ?? null,
                    tinRawResponse: verificationResult.tin.rawResponse || null,

                    // CAC Document OCR results
                    cacOcrVerified: verificationResult.ocr.verified,
                    cacOcrVerifiedAt: verificationResult.ocr.verified ? new Date() : null,
                    cacOcrExtractedNumber: verificationResult.ocr.extractedNumber || null,
                    cacOcrExtractedName: verificationResult.ocr.extractedName || null,
                    cacOcrNumberMatches: verificationResult.ocr.numberMatches ?? null,
                    cacOcrRawResponse: verificationResult.ocr.rawResponse || null,
                },
            });

            this.logger.log(
                `[DojahBusinessVerification] Completed for user ${userId}: ` +
                `CAC=${verificationResult.cac.verified}(name=${verificationResult.cac.nameMatches}), ` +
                `TIN=${verificationResult.tin.verified}(name=${verificationResult.tin.nameMatches}), ` +
                `OCR=${verificationResult.ocr.verified}(num=${verificationResult.ocr.numberMatches})`
            );
        } catch (error) {
            this.logger.error(
                `[DojahBusinessVerification] Failed for user ${userId}: ${error?.message}`,
                error?.stack
            );
            // Don't re-throw — this is a background task
        }
    }

    private getTrustedDocumentOrigins(): Set<string> {
        const trustedOrigins = new Set<string>();

        if (imagekitConfig.url) {
            try {
                trustedOrigins.add(new URL(imagekitConfig.url).origin);
            } catch {
                this.logger.warn("Invalid IMAGEKIT_URL configured; skipping URL origin allowlist entry");
            }
        }

        if (cloudinaryConfig.cloud_name) {
            trustedOrigins.add(`https://res.cloudinary.com/${cloudinaryConfig.cloud_name}`);
        }

        // Keep a safe fallback for standard ImageKit domains.
        trustedOrigins.add("https://ik.imagekit.io");

        return trustedOrigins;
    }

    private resolveTrustedDocumentUrl(rawUrl: string): URL | null {
        try {
            const parsedUrl = new URL(rawUrl);
            if (parsedUrl.protocol !== "https:") {
                return null;
            }

            return this.getTrustedDocumentOrigins().has(parsedUrl.origin)
                ? parsedUrl
                : null;
        } catch {
            return null;
        }
    }

    /**
     * Dojah verification variant that fetches the CAC image from a URL
     * instead of requiring a Multer file buffer.
     * Used by the sequential-upload submit flow.
     */
    private async runDojahBusinessVerificationFromStoredDocument(
        userId: number,
        cacDocumentNumber: string,
    ): Promise<void> {
        const businessDocument = await this.prisma.businessDocument.findUnique({
            where: { userId },
            select: { cacImageUrl: true },
        });
        const cacImageUrl = businessDocument?.cacImageUrl;

        if (!cacImageUrl) {
            this.logger.warn(
                `[DojahBusinessVerificationFromUrl] No CAC image URL for user ${userId}, skipping`
            );
            return;
        }

        const trustedImageUrl = this.resolveTrustedDocumentUrl(cacImageUrl);
        if (!trustedImageUrl) {
            this.logger.warn(
                `[DojahBusinessVerificationFromUrl] Untrusted CAC image URL for user ${userId}, skipping`
            );
            return;
        }

        try {
            // Fetch image from ImageKit URL and convert to base64
            const response = await axios.get(trustedImageUrl.toString(), {
                responseType: "arraybuffer",
                timeout: 30000,
                maxRedirects: 0,
            });
            const buffer = Buffer.from(response.data);

            // Create a synthetic Multer-like file object
            const syntheticFile: Express.Multer.File = {
                buffer,
                fieldname: "cacImage",
                originalname: "cacImage.webp",
                encoding: "7bit",
                mimetype: "image/webp",
                size: buffer.length,
                stream: null as any,
                destination: "",
                filename: "",
                path: "",
            };

            await this.runDojahBusinessVerification(
                userId,
                cacDocumentNumber,
                syntheticFile
            );
        } catch (error) {
            this.logger.error(
                `[DojahBusinessVerificationFromUrl] Failed for user ${userId}: ${error?.message}`,
                error?.stack
            );
        }
    }

    async submitBusinessRecord(user: User, dto: SubmitBusinessRecordDto) {
        const record = await this.prisma.$transaction(
            async (tx) => {
                const record = await tx.businessRecord.upsert({
                    where: { userId: user.id },
                    update: {
                        businessName: dto.businessName,
                        natureOfBusiness: dto.natureOfBusiness,
                        expectedTransactionFrequency:
                            dto.expectedTransactionFrequency,
                        expectedTransactionVolume:
                            dto.expectedTransactionVolumes,
                        taxIdentificationNumber: dto.taxIdentificationNumber,
                    },
                    create: {
                        userId: user.id,
                        businessName: dto.businessName,
                        natureOfBusiness: dto.natureOfBusiness,
                        expectedTransactionFrequency:
                            dto.expectedTransactionFrequency,
                        expectedTransactionVolume:
                            dto.expectedTransactionVolumes,
                        taxIdentificationNumber: dto.taxIdentificationNumber,
                    },
                });

                await tx.user.update({
                    where: { id: user.id },
                    data: {
                        businessRecordCompleted: true,
                        firstName: dto.firstName,
                        lastName: dto.lastName,
                        businessName: dto.businessName,
                    },
                });
                return record;
            },
            { maxWait: 10000, timeout: 30000 }
        );

        await this.cryptoAccountQueueProducer.enqueue(user.id);
        await this.redisCacheService.del(this.getProfileCacheKey(user.id));

        return buildResponse({
            message: "Business record submitted successfully",
            data: record,
        });
    }

    async userSignIn(options: UserSigInDto, ip: string): Promise<ApiResponse> {
        return await this.signIn(options, LoginPlatform.USER, ip);
    }

    async adminSignIn(options: UserSigInDto, ip: string): Promise<ApiResponse> {
        return await this.signIn(options, LoginPlatform.ADMIN, ip);
    }

    private async signIn(
        options: SignInOptions,
        loginPlatform: LoginPlatform,
        ip: string
    ): Promise<ApiResponse> {
        const baseSelect = {
            id: true,
            identifier: true,
            password: true,
            userType: true,
            status: true,
            role: { select: { name: true, rolePermission: true } },
            lastLogin: true,
            loginCount: true,
            flaggedRecord: true,
            flaggedId: true,
            email: true,
            isEmailVerified: true,
            isPhoneVerified: true,
            isPasswordCreated: true,
            isBvnVerified: true,
            isDocumentVerified: true,
            businessRecordCompleted: true,
            businessDocumentVerificationStatus: true,
            isTwoFactorEnabled: true,
            twoFactorSecret: true,
            // Account lockout fields
            failedLoginAttempts: true,
            lastFailedLogin: true,
            lockedUntil: true,
        };

        const email = options.email.toLowerCase().trim();
        const user = await this.prisma.user.findUnique({
            where: { email },
            select:
                loginPlatform === LoginPlatform.USER
                    ? baseSelect
                    : {
                        ...baseSelect,
                        isEmailVerified: false,
                        isPhoneVerified: false,
                        isPasswordCreated: false,
                        isBvnVerified: false,
                        isDocumentVerified: false,
                        businessRecordCompleted: false,
                        businessDocumentVerificationStatus: false,
                    },
        });

        if (!user) {
            throw new InvalidCredentialException("Invalid email or password");
        }

        const flagged = user.flaggedRecord || { flagged: false, reason: "" };
        if (
            flagged.flagged &&
            flagged.reason === "Multiple failed login attempts"
        ) {
            throw new UserAccountDisabledException(
                `Account is flagged: ${flagged.reason || "Multiple failed login attempts"
                }. Please contact support.`,
                HttpStatus.FORBIDDEN
            );
        }

        if (user.status === Status.BLOCKED) {
            throw new UserAccountDisabledException(
                "Account is disabled. Kindly contact customer support",
                HttpStatus.BAD_REQUEST
            );
        }

        this.validateLoginPlatform(user.userType, loginPlatform);

        if (!user.password) {
            throw new AuthGenericException(
                "Please create your password first",
                HttpStatus.BAD_REQUEST
            );
        }

        Logger.log(`[LoginDebug] Attempting login for ${user.email}. Hash exists: ${!!user.password}`);

        const passwordMatch = await this.comparePassword(
            options.password,
            user.password
        );

        Logger.log(`[LoginDebug] Password match result for ${user.email}: ${passwordMatch}`);

        if (!passwordMatch) {
            await this.handleFailedLogin(user, ip);
            throw new InvalidCredentialException("Invalid email or password");
        }

        // Check if 2FA is enabled - return temporary token for 2FA verification
        // Apply to BOTH user and admin logins for enhanced security
        if (user.isTwoFactorEnabled && user.twoFactorSecret) {

            const tempToken = await this.jwtService.signAsync(
                { sub: user.id, type: "2fa_pending", platform: loginPlatform },
                { secret: jwtSecret, expiresIn: "5m" }
            );

            return buildResponse({
                message: "Two-factor authentication required",
                data: {
                    requiresTwoFactor: true,
                    tempToken: tempToken,
                    email: user.email, // Help user identify which account
                },
            });
        }

        // Create session for user logins with error handling
        // Session creation failure should NOT prevent login
        let sessionId: string | undefined;
        if (loginPlatform === LoginPlatform.USER) {
            try {
                const sessionInfo: SessionInfo = {
                    deviceName: options.deviceName,
                    deviceType: options.deviceType,
                    browser: options.browser,
                    os: options.os,
                    ipAddress: ip,
                };
                const sessionResult = await this.sessionService.createSession(
                    user.id,
                    sessionInfo
                );
                sessionId = sessionResult.sessionId;
            } catch (sessionError) {
                // Log the error but don't fail the login
                Logger.error(`Failed to create session for user ${user.id}: ${sessionError.message}`);
                // Session creation is non-critical, login should still succeed
            }
        }

        const tokenPayload: Record<string, any> = {
            sub: user.id,
            platform: loginPlatform,
            ...(sessionId ? { sessionId } : {}),
        };

        const tokens = await this.generateTokens(tokenPayload);

        await this.saveRefreshToken(user.id, tokens.refreshToken);

        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                ipAddress: ip,
                loginCount: 0,
                lastLogin: new Date(),
            },
        });

        if (loginPlatform === LoginPlatform.ADMIN) {
            return buildResponse({
                message: "Login successful",
                data: {
                    accessToken: tokens.accessToken,
                    refreshToken: tokens.refreshToken,
                    userType: user.userType,
                },
            });
        }

        const verificationStatus: VerificationStatus = {
            isEmailVerified: user.isEmailVerified,
            isPhoneVerified: user.isPhoneVerified,
            isPasswordCreated: user.isPasswordCreated,
            isBvnVerified: user.isBvnVerified,
            isDocumentVerified: user.isDocumentVerified,
        };

        if (user.userType.toLowerCase() === "business") {
            verificationStatus.businessRecordCompleted =
                user.businessRecordCompleted;
            verificationStatus.businessDocumentVerificationStatus =
                user.businessDocumentVerificationStatus || null;
        }

        const responseData = {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            sessionId,
            userType: user.userType.toLowerCase(),
            verificationStatus,
        };

        return buildResponse({
            message: "Login successful",
            data: responseData,
        });
    }

    async refreshToken(options: RefreshTokenDto): Promise<ApiResponse> {
        const payload = this.jwtService.verify<DataStoredInToken>(options.refreshToken, {
            secret: jwt_refresh_secret,
        });

        // SECURITY: Distributed lock prevents concurrent refresh token rotation race condition
        return this.distributedLockService.withLock(
            `refresh:${payload.sub}`,
            async () => {
                const validationResult = await this.validateRefreshToken(
                    payload.sub,
                    options.refreshToken
                );

                if (!validationResult.valid) {
                    if (validationResult.reuse) {
                        // Token reuse detected — possible theft. Invalidate entire family.
                        Logger.warn(`SECURITY: Refresh token reuse detected for user ${payload.sub}. Invalidating all tokens.`);
                        await this.prisma.user.update({
                            where: { id: payload.sub },
                            data: { refreshToken: null, refreshTokenFamily: null },
                        });
                    }
                    throw new InvalidRefreshToken(
                        "Invalid refresh token",
                        HttpStatus.UNAUTHORIZED
                    );
                }

                if (payload.sessionId) {
                    const isSessionValid = await this.sessionService.validateSession(
                        payload.sessionId
                    );

                    if (!isSessionValid) {
                        throw new InvalidRefreshToken(
                            "Session expired or invalid",
                            HttpStatus.UNAUTHORIZED
                        );
                    }
                }

                const newTokens = await this.generateTokens({
                    sub: payload.sub,
                    ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
                });

                // Rotate token but keep the same family
                await this.saveRefreshToken(payload.sub, newTokens.refreshToken, validationResult.family);

                return buildResponse({
                    message: `Refresh token generated`,
                    data: newTokens,
                });
            },
            { ttlMs: 10000, maxWaitMs: 5000 }
        );
    }

    private hashToken(token: string): string {
        return crypto.createHash("sha256").update(token).digest("hex");
    }

    async saveRefreshToken(id: number, refreshToken: string, family?: string) {
        return this.prisma.user.update({
            where: { id: id },
            data: {
                refreshToken: this.hashToken(refreshToken),
                refreshTokenFamily: family ?? crypto.randomUUID(),
            },
        });
    }

    async validateRefreshToken(
        id: number,
        refreshToken: string
    ): Promise<{ valid: boolean; reuse?: boolean; family?: string }> {
        const user = await this.prisma.user.findUnique({
            where: { id: id },
            select: { refreshToken: true, refreshTokenFamily: true },
        });
        if (!user?.refreshToken) return { valid: false };
        const hashedIncoming = this.hashToken(refreshToken);
        if (user.refreshToken.length !== hashedIncoming.length) {
            return { valid: false, reuse: !!user.refreshTokenFamily };
        }
        try {
            const matches = crypto.timingSafeEqual(
                Buffer.from(user.refreshToken, "utf8"),
                Buffer.from(hashedIncoming, "utf8")
            );
            if (matches) {
                return { valid: true, family: user.refreshTokenFamily ?? undefined };
            }
            return { valid: false, reuse: !!user.refreshTokenFamily };
        } catch {
            return { valid: false };
        }
    }

    /**
     * Verify 2FA code and complete login
     */
    async verify2FALogin(dto: Verify2FALoginDto, ip: string): Promise<ApiResponse> {
        // Verify the temp token
        let payload: { sub: number; type: string; platform: LoginPlatform };
        try {
            payload = await this.jwtService.verifyAsync(dto.tempToken, {
                secret: jwtSecret,
            });
        } catch {
            throw new UserUnauthorizedException(
                "Invalid or expired token. Please log in again.",
                HttpStatus.UNAUTHORIZED
            );
        }

        if (payload.type !== "2fa_pending") {
            throw new UserUnauthorizedException(
                "Invalid token type",
                HttpStatus.UNAUTHORIZED
            );
        }

        // Get user with 2FA details
        const user = await this.prisma.user.findUnique({
            where: { id: payload.sub },
            select: {
                id: true,
                twoFactorSecret: true,
                isTwoFactorEnabled: true,
                userType: true,
                isEmailVerified: true,
                isPhoneVerified: true,
                isPasswordCreated: true,
                isBvnVerified: true,
                isDocumentVerified: true,
                businessRecordCompleted: true,
                businessDocumentVerificationStatus: true,
            },
        });

        if (!user?.isTwoFactorEnabled || !user?.twoFactorSecret) {
            throw new UserUnauthorizedException(
                "2FA is not enabled for this account",
                HttpStatus.BAD_REQUEST
            );
        }

        // Try TOTP code first (verify before checking rate limit - correct code bypasses lockout)
        let isValid = authenticator.verify({
            token: dto.code,
            secret: decryptField(user.twoFactorSecret),
        });

        // If TOTP fails, try backup code
        if (!isValid) {
            isValid = await this.settingService.verifyBackupCode(user.id, dto.code);
        }

        if (isValid) {
            // Correct code - clear any lockout and proceed
            await this.twoFactorRateLimitService.recordSuccessfulAttempt(
                user.id.toString(),
                'login'
            );
        } else {
            // Invalid code - check rate limit and apply lockout
            const rateLimitResult = await this.twoFactorRateLimitService.checkAttempt(
                user.id.toString(),
                'login'
            );

            if (!rateLimitResult.allowed) {
                throw new TwoFactorLockedException(
                    "Too many failed 2FA attempts",
                    rateLimitResult.lockoutDuration
                );
            }

            // Record failed attempt with exponential backoff
            const failedResult = await this.twoFactorRateLimitService.recordFailedAttempt(
                user.id.toString(),
                'login'
            );

            if (failedResult.lockoutEndsAt) {
                throw new TwoFactorLockedException(
                    "Invalid verification code",
                    failedResult.lockoutDuration
                );
            }

            throw new Invalid2FACodeException(
                `Invalid verification code. ${failedResult.remainingAttempts} attempts remaining.`
            );
        }

        // Create session for user logins (2FA complete) with error handling
        // Session creation failure should NOT prevent login
        let sessionId: string | undefined;
        if (payload.platform === LoginPlatform.USER) {
            try {
                const sessionInfo: SessionInfo = {
                    deviceName: dto.deviceName,
                    deviceType: dto.deviceType,
                    browser: dto.browser,
                    os: dto.os,
                    ipAddress: ip,
                };
                const sessionResult = await this.sessionService.createSession(
                    user.id,
                    sessionInfo
                );
                sessionId = sessionResult.sessionId;
            } catch (sessionError) {
                // Log the error but don't fail the login
                Logger.error(`Failed to create 2FA session for user ${user.id}: ${sessionError.message}`);
                // Session creation is non-critical, login should still succeed
            }
        }

        const tokens = await this.generateTokens({
            sub: user.id,
            platform: payload.platform,
            ...(sessionId ? { sessionId } : {}),
        });

        await this.saveRefreshToken(user.id, tokens.refreshToken);

        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                ipAddress: ip,
                loginCount: 0,
                lastLogin: new Date(),
            },
        });

        const verificationStatus: VerificationStatus = {
            isEmailVerified: user.isEmailVerified,
            isPhoneVerified: user.isPhoneVerified,
            isPasswordCreated: user.isPasswordCreated,
            isBvnVerified: user.isBvnVerified,
            isDocumentVerified: user.isDocumentVerified,
        };

        if (user.userType.toLowerCase() === "business") {
            verificationStatus.businessRecordCompleted =
                user.businessRecordCompleted;
            verificationStatus.businessDocumentVerificationStatus =
                user.businessDocumentVerificationStatus || null;
        }

        return buildResponse({
            message: "Login successful",
            data: {
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                sessionId,
                userType: user.userType.toLowerCase(),
                verificationStatus,
            },
        });
    }

    /**
     * Reset 2FA rate limit for a user (Admin function)
     */
    async reset2FARateLimit(dto: { userId: number; context?: "login" | "transaction" }): Promise<ApiResponse> {
        // Verify user exists
        const user = await this.prisma.user.findUnique({
            where: { id: dto.userId },
            select: { id: true, email: true, isTwoFactorEnabled: true },
        });

        if (!user) {
            throw new UserNotFoundException("User not found");
        }

        // Reset rate limit
        await this.twoFactorRateLimitService.resetAttempts(
            user.id.toString(),
            dto.context
        );

        const contextMsg = dto.context
            ? `${dto.context} 2FA rate limit`
            : "all 2FA rate limits";

        return buildResponse({
            message: `Successfully reset ${contextMsg} for user ${user.email}`,
            data: {
                userId: user.id,
                email: user.email,
                contextReset: dto.context || "all",
            },
        });
    }


}

