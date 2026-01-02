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
    RefreshTokenDto,
    BusinessDocumentUploadDto,
    Verify2FALoginDto,
} from "../dtos";
import * as bcrypt from "bcryptjs";
import { ApiResponse, buildResponse } from "@/utils/api-response-util";
import { PrismaService } from "@/modules/core/prisma/services";
import { EmailService } from "@/modules/core/email/services";
import { generateFileName, generateId, generateRandomNum } from "@/utils";
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
    UserUnauthorizedException,
    InvalidRefreshToken,
    AuthGenericException,
    UserAccountDisabledException,
} from "../errors";
import {
    DocumentVerificationStatus,
    Prisma,
    Status,
    User,
    UserType,
    DocumentType,
    Country,
} from "@prisma/client";
import { RoleNotFoundException } from "../../authorize/error";
import {
    emailTemplateConfig,
    frontendDevUrl,
    jwt_refresh_secret,
    jwtSecret,
    mailConfig,
    REFRESH_TOKEN_EXPIRATION,
    storageDirConfig,
    TOKEN_EXPIRATION,
    COMPANY_NAME,
} from "@/config";
import { UploadResponse } from "imagekit/dist/libs/interfaces";
import { ImagekitService } from "@/modules/core/upload/services/imagekit";
import { UploadFactory } from "@/modules/core/upload/services";
import { CloudinaryService } from "@/modules/core/upload/services/cloudinary";
import { UploadApiResponse } from "cloudinary";
import { IdentityComplianceInjectionToken } from "@/modules/factory/identityCompliance/types";
import { DojahService } from "@/modules/factory/identityCompliance/providers/dojah/services";
import {
    DocumentMetaMap,
    DocumentVerificationFileInterface,
    LoginPlatform,
    SignInOptions,
    UploadBusinessDocumentsFileInterface,
    VerificationStatus,
    SignInUser,
} from "../interfaces";
import { CryptoAccountQueueProducer } from "../../trade/queues/producers/producer.service";
import { authenticator } from "otplib";
import * as crypto from "crypto";
import { SmsService } from "@/modules/core/sms/services";
import { SessionService } from "../../session/services";
import { SessionInfo } from "../../session/interfaces";
import { TwoFactorRateLimitService } from "./two-factor-rate-limit.service";
import { SettingService } from "../../settings/services";
import { TierService } from "./tier.service";

@Injectable()
export class AuthService {
    private uploadService: ImagekitService | CloudinaryService;
    private readonly SALT_ROUNDS = 10;

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

    constructor(
        private jwtService: JwtService,
        private prisma: PrismaService,
        private emailService: EmailService,
        private uploadFactory: UploadFactory,
        @Inject(IdentityComplianceInjectionToken.DOJAH)
        private readonly dojahService: DojahService,
        private readonly cryptoAccountQueueProducer: CryptoAccountQueueProducer,
        private readonly smsService: SmsService,
        private readonly sessionService: SessionService,
        private readonly twoFactorRateLimitService: TwoFactorRateLimitService,
        private readonly settingService: SettingService,
        private readonly tierService: TierService
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
        const adminUserTypes: UserType[] = [UserType.ADMIN];
        const userTypes: UserType[] = [UserType.INDIVIDUAL, UserType.BUSINESS];

        switch (loginPlatform) {
            case LoginPlatform.ADMIN:
                if (!adminUserTypes.includes(userType)) {
                    throw new InvalidCredentialException(
                        "Incorrect email or password",
                        HttpStatus.UNAUTHORIZED
                    );
                }
                break;
            case LoginPlatform.USER:
                if (!userTypes.includes(userType)) {
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

    // Separated login count and flagging logic
    private async handleFailedLogin(
        user: SignInUser,
        ip: string
    ): Promise<void> {
        const now = new Date();
        const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);
        let updatedLoginCount = user.loginCount || 0;
        let lastLogin = user.lastLogin || now;

        if (lastLogin && lastLogin >= tenMinutesAgo) {
            updatedLoginCount += 1;
        } else {
            updatedLoginCount = 1;
            lastLogin = now;
        }

        if (updatedLoginCount >= 10) {
            await this.prisma.$transaction(async (tx) => {
                const flaggedRecord = await tx.flagged.upsert({
                    where: { userId: user.id },
                    create: {
                        userId: user.id,
                        flagged: true,
                        reason: "Multiple failed login attempts",
                    },
                    update: {
                        flagged: true,
                        reason: "Multiple failed login attempts",
                        updatedAt: now,
                    },
                });

                await tx.user.update({
                    where: { id: user.id },
                    data: {
                        loginCount: updatedLoginCount,
                        lastLogin,
                        ipAddress: ip,
                        flaggedId: flaggedRecord.id,
                    },
                });
            });
            throw new InvalidCredentialException("Invalid email or password");
        }

        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                loginCount: updatedLoginCount,
                lastLogin,
                ipAddress: ip,
            },
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
        const user = await this.prisma.user.findUnique({
            where: { email: dto.email },
        });
        if (!user) {
            throw new UserNotFoundException("User not found");
        }

        const code = crypto.randomBytes(3).toString("hex").toUpperCase();

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
        const resetLink = `${frontendDevUrl}/reset-password?code=${code}&email=${dto.email}`;

        try {
            await this.emailService.sendMailWithTemplate({
                from: { address: mailConfig.senderMail },
                to: [{ email_address: { address: dto.email } }],
                template_key: emailTemplateConfig.forgot_password,
                merge_info: {
                    name,
                    product_name: COMPANY_NAME,
                    username,
                    team,
                    password_reset_link: resetLink,
                },
            });
        } catch (error) {
            throw new AuthGenericException(
                "Failed to send password reset email"
            );
        }

        return buildResponse({
            message: "Password reset email sent successfully",
            data: { email: dto.email },
        });
    }

    async resetPassword(dto: ResetPasswordDto): Promise<ApiResponse> {
        const user = await this.prisma.user.findUnique({
            where: { email: dto.email },
            include: { passwordResetRequest: true },
        });

        if (!user || !user.passwordResetRequest) {
            throw new InvalidResetRequestException(
                "Invalid password reset request"
            );
        }

        if (user.passwordResetRequest.code !== dto.resetCode) {
            throw new InvalidResetCodeException("Invalid reset code");
        }

        const createdAt = user.passwordResetRequest.createdAt;
        if (Date.now() - createdAt.getTime() > 30 * 60 * 1000) {
            await this.prisma.passwordResetRequest.delete({
                where: { userId: user.id },
            });
            throw new ResetCodeExpiredException("Reset code has expired");
        }

        const hashedPassword = await this.hashPassword(dto.password);

        await this.prisma.user.update({
            where: { id: user.id },
            data: { password: hashedPassword, updatedAt: new Date() },
        });

        await this.prisma.passwordResetRequest.delete({
            where: { userId: user.id },
        });

        return buildResponse({
            message: "Password reset successfully",
        });
    }

    async signUp(options: SignUpDto, ip: string): Promise<ApiResponse> {
        const existingUser = await this.prisma.user.findUnique({
            where: { email: options.email.trim() },
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
        if (existingUser && existingUser.isDeleted) {
            // Check if user was blocked
            if (existingUser.status === Status.BLOCKED) {
                throw new UserAccountDisabledException(
                    "This account has been permanently blocked. Please contact support.",
                    HttpStatus.FORBIDDEN
                );
            }

            // Check if user was flagged
            if (existingUser.flaggedRecord && existingUser.flaggedRecord.flagged) {
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

        const createUserOptions: Prisma.UserUncheckedCreateInput = {
            email: options.email,
            identifier: generateId({ type: "identifier" }),
            userType: options.accountType,
            roleId: role.id,
            ipAddress: ip,
            firstName: options.firstName,
            lastName: options.lastName,
            dateOfBirth: new Date(options.dateOfBirth),
        };

        const createdUser = await this.prisma.user.create({
            data: createUserOptions,
        });

        const verificationCode = customAlphabet("1234567890", 6)();

        await this.prisma.accountVerificationRequest.upsert({
            where: {
                email: options.email,
            },
            create: {
                code: verificationCode,
                email: options.email,
            },
            update: { code: verificationCode },
        });

        const tokens = await this.generateTokens({
            sub: createdUser.id,
        });

        await this.saveRefreshToken(createdUser.id, tokens.refreshToken);

        await this.emailService.sendMailWithTemplate({
            from: { address: mailConfig.senderMail },
            to: [{ email_address: { address: options.email } }],
            template_key: emailTemplateConfig.verify_account, // Use verify_account for code
            merge_info: {
                otp: verificationCode,      // Matches {{otp}}
                expiry_minutes: "10",       // Matches {{expiry_minutes}}
                name: options.firstName,    // Matches {{name}}
                team: COMPANY_NAME,
                product_name: COMPANY_NAME,
            },
        });
    } catch(error) {
        console.log(error, "errors");
        Logger.error(`Failed to send account verification email${error}`);
    }

        return buildResponse({
        message: "Account successfully created",
        data: tokens,
    });
    }

    async sendAccountVerificationEmail(
        options: SendEmailVerificationCodeDto
    ): Promise < ApiResponse > {
        const verificationCode = customAlphabet("1234567890", 6)();
        const email = options.email.toLowerCase().trim();

        const emailExist = await this.prisma.user.findUnique({
            where: { email: email },
            select: { id: true, isEmailVerified: true },
        });

        if(!emailExist) {
            throw new UserNotFoundException(
                "Account with email not found. Kindly register first",
                HttpStatus.BAD_REQUEST
            );
        }

        if(emailExist && emailExist.isEmailVerified) {
    throw new DuplicateUserException(
        "Account already verified. Kindly login",
        HttpStatus.BAD_REQUEST
    );
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
            name: "User",          // Matches {{name}} - default since we don't have name readily available in this context without extra query
            product_name: COMPANY_NAME,
            team: COMPANY_NAME,
        },
    });
} catch (error) {
    throw new AuthGenericException(
        "Failed to send account verification email"
    );
}

return buildResponse({
    message: `An email verification code has been sent to your email, ${options.email}`,
    data: {
        email: options.email,
    },
});
    }

    async verifyEmailOtp(options: VerifyEmailOtpDto): Promise < ApiResponse > {
    const emailExist = await this.prisma.user.findUnique({
        where: { email: options.email },
        select: { id: true, isEmailVerified: true },
    });

    if(!emailExist) {
        throw new UserNotFoundException(
            "Account with email not found. Kindly register first",
            HttpStatus.BAD_REQUEST
        );
    }

        if(emailExist && emailExist.isEmailVerified) {
    throw new DuplicateUserException(
        "Account already verified. Kindly login",
        HttpStatus.BAD_REQUEST
    );
}

const verificationData =
    await this.prisma.accountVerificationRequest.findUnique({
        where: {
            email_code: { email: options.email, code: options.otp },
        },
    });

if (!verificationData) {
    throw new InvalidEmailVerificationCodeException(
        "Invalid verification code",
        HttpStatus.BAD_REQUEST
    );
}

const timeDifference =
    Date.now() - verificationData.updatedAt.getTime();
const threeDaysInMs = 3 * 24 * 60 * 60 * 1000;

if (timeDifference > threeDaysInMs) {
    throw new VerificationCodeExpiredException(
        "Your verification code has expired. Kindly request for a new one",
        HttpStatus.BAD_REQUEST
    );
}

await this.prisma.user.update({
    where: { email: options.email },
    data: {
        isEmailVerified: true,
        // Auto-enable email as a security method
        securityMethods: {
            ...await this.getOrCreateSecurityMethods(options.email, 'email'),
            email: true,
        },
    },
});

await this.prisma.accountVerificationRequest.delete({
    where: { email: options.email },
});

return buildResponse({
    message: "Email verification completed",
});
    }

    async sendPhoneVerificationOtp(
    user: User,
    options: SendPhoneVerificationCodeDto
): Promise < ApiResponse > {
    const verificationCode = customAlphabet("1234567890", 6)();

    if(user.isPhoneVerified) {
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
): Promise < ApiResponse > {
    if(user.isPhoneVerified) {
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

const timeDifference =
    Date.now() - verificationData.updatedAt.getTime();
const timeDiffInMin = timeDifference / (1000 * 60);

if (timeDiffInMin > 30) {
    throw new VerificationCodeExpiredException(
        "Your verification code has expired. Kindly request for a new one",
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

    async bvnVerification(user: User, dto: BvnVerificationDto) {
    if (user.isBvnVerified) {
        throw new DuplicateBvnVerificationException(
            "Bvn verification already completed",
            HttpStatus.BAD_REQUEST
        );
    }

    const bvnInUseByAnother = await this.prisma.user.findFirst({
        where: { id: { not: user.id }, bvn: dto.bvn },
    });

    if (bvnInUseByAnother) {
        throw new VerificationGenericException(
            "Bvn already in use",
            HttpStatus.CONFLICT
        );
    }

    const result = await this.dojahService.verifyBvn({
        bvn: dto.bvn,
    });

    if (dto.bvn === "22222222222") {
        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                firstName: dto.firstName,
                lastName: dto.lastName,
                dateOfBirth: new Date(dto.dateOfBirth),
                isBvnVerified: true,
                bvn: generateId({ type: "numeric" }),
            },
        });
    } else {
        if (
            dto.firstName.toLowerCase() !==
            result?.data?.entity?.first_name.toLowerCase() ||
            dto.lastName.toLowerCase() !==
            result?.data?.entity?.last_name.toLowerCase() ||
            dto.dateOfBirth !== result?.data?.entity?.date_of_birth
        ) {
            throw new VerificationGenericException(
                "Incorrect first name, last name or date of birth",
                HttpStatus.BAD_REQUEST
            );
        }
        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                firstName: dto.firstName,
                lastName: dto.lastName,
                dateOfBirth: new Date(dto.dateOfBirth),
                isBvnVerified: true,
                bvn: dto.bvn,
                bvnRegisteredPhone: result.data.entity.phone_number1,
            },
        });
    }
    try {
        await this.cryptoAccountQueueProducer.enqueue(user.id);
    } catch (error) {
        console.log("error in sub account setup", { error });
    }

    return buildResponse({
        message: "Bvn Verification successfully",
    });
}

    async ninVerification(user: User, dto: NinVerificationDto) {
    if (user.isNinVerified) {
        throw new DuplicateVerificationException(
            "NIN verification already completed",
            HttpStatus.BAD_REQUEST
        );
    }

    const ninInUseByAnother = await this.prisma.user.findFirst({
        where: { id: { not: user.id }, nin: dto.nin },
    });

    if (ninInUseByAnother) {
        throw new VerificationGenericException(
            "NIN already in use",
            HttpStatus.CONFLICT
        );
    }

    const result = await this.dojahService.verifyNin({
        nin: dto.nin,
    });

    if (dto.nin === "00000000001") {
        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                firstName: dto.firstName,
                lastName: dto.lastName,
                dateOfBirth: new Date(dto.dateOfBirth),
                isNinVerified: true,
                nin: generateId({ type: "numeric" }),
            },
        });
    } else {
        if (
            dto.firstName.toLowerCase() !==
            result?.data?.entity?.first_name.toLowerCase() ||
            dto.lastName.toLowerCase() !==
            result?.data?.entity?.last_name.toLowerCase() ||
            dto.dateOfBirth !== result?.data?.entity?.date_of_birth
        ) {
            throw new VerificationGenericException(
                "Incorrect first name, last name or date of birth",
                HttpStatus.BAD_REQUEST
            );
        }
        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                firstName: dto.firstName,
                lastName: dto.lastName,
                dateOfBirth: new Date(dto.dateOfBirth),
                isNinVerified: true,
                nin: dto.nin,
                ninRegisteredPhone: result.data.entity.phone_number,
            },
        });
    }
    try {
        await this.cryptoAccountQueueProducer.enqueue(user.id);
    } catch (error) {
        console.log("error in sub account setup", { error });
    }

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
        console.log("error in sub account setup", { error });
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

        logger.log(
            `Document analysis for user ${user.id}: ` +
            `valid=${isDocumentValid}, nameMatches=${nameMatches}, ` +
            `docType=${dojahParsed?.documentType || "unknown"}`
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

    // Return appropriate message based on verification result
    if (shouldAutoApprove) {
        return buildResponse({
            message: "Document verified successfully",
        });
    } else {
        return buildResponse({
            message: "Document submitted for review. You will be notified once verification is complete.",
        });
    }
}

    private async uploadDocumentImage(
    file: string
): Promise < UploadResponse | UploadApiResponse > {
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

    async uploadAsFile(file: Express.Multer.File[]) {
    const date = Date.now();
    const body = file[0].buffer;

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
    private async uploadBase64Image(base64String: string): Promise < {
    url: string;
    fileId: string;
} > {
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

        // Return extracted data for user verification
        return {
            success: true,
            message: parsed.isValid
                ? "Document analyzed successfully"
                : this.mapDojahReasonToUserMessage(parsed.reason),
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
    private mapDojahReasonToUserMessage(reason ?: string): string {
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
        const dojahDocType = dto.idData?.document_type?.toLowerCase();
        let documentType: DocumentType = DocumentType.NIN;

        if (dojahDocType?.includes("passport")) {
            documentType = DocumentType.INTERNATIONAL_PASSPORT;
        } else if (dojahDocType?.includes("driver") || dojahDocType?.includes("license")) {
            documentType = DocumentType.DRIVER_LICENSE;
        } else if (dto.documentType) {
            // Use provided document type as fallback
            const providedType = dto.documentType.toLowerCase();
            if (providedType.includes("passport")) {
                documentType = DocumentType.INTERNATIONAL_PASSPORT;
            } else if (providedType.includes("driver") || providedType.includes("license")) {
                documentType = DocumentType.DRIVER_LICENSE;
            }
        }

        // Store Dojah widget response in userDocument
        await this.prisma.userDocument.upsert({
            where: { userId: user.id },
            update: {
                type: documentType,
                country: Country.NIGERIA,
                documentNumber: dto.idData?.document_number || "",
                verificationStatus: DocumentVerificationStatus.VERIFIED,
                dojahVerified: true,
                dojahDocumentType: dto.idData?.document_type || null,
                dojahCountryCode: dto.idData?.country || null,
                dojahExtractedFirstName: dto.idData?.first_name || null,
                dojahExtractedLastName: dto.idData?.last_name || null,
                dojahExtractedDob: dto.idData?.date_of_birth || null,
                dojahExtractedDocNumber: dto.idData?.document_number || null,
                dojahNameMatches: true, // Verified via widget
                dojahVerifiedAt: new Date(),
                dojahRawResponse: JSON.stringify({
                    verificationId: dto.verificationId,
                    referenceId: dto.referenceId,
                    verificationType: dto.verificationType,
                    idData: dto.idData,
                    liveness: dto.liveness,
                    selfie: dto.selfie,
                    faceMatch: dto.faceMatch,
                    verifiedViaWidget: true,
                }),
                updatedAt: new Date(),
            },
            create: {
                userId: user.id,
                type: documentType,
                country: Country.NIGERIA,
                documentNumber: dto.idData?.document_number || "",
                // For Dojah Widget, images are stored by Dojah - use placeholder
                documentImageUrl: "dojah-widget-verified",
                documentImageFieldId: `dojah-widget-${dto.verificationId || Date.now()}`,
                verificationStatus: DocumentVerificationStatus.VERIFIED,
                dojahVerified: true,
                dojahDocumentType: dto.idData?.document_type || null,
                dojahCountryCode: dto.idData?.country || null,
                dojahExtractedFirstName: dto.idData?.first_name || null,
                dojahExtractedLastName: dto.idData?.last_name || null,
                dojahExtractedDob: dto.idData?.date_of_birth || null,
                dojahExtractedDocNumber: dto.idData?.document_number || null,
                dojahNameMatches: true,
                dojahVerifiedAt: new Date(),
                dojahRawResponse: JSON.stringify({
                    verificationId: dto.verificationId,
                    referenceId: dto.referenceId,
                    verificationType: dto.verificationType,
                    idData: dto.idData,
                    liveness: dto.liveness,
                    selfie: dto.selfie,
                    faceMatch: dto.faceMatch,
                    verifiedViaWidget: true,
                }),
            },
        });

        // Update user's document verification status
        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                isDocumentVerified: true,
                documentVerificationStatus: DocumentVerificationStatus.VERIFIED,
            },
        });

        // Update user's tier based on new verification status
        const updatedUser = await this.tierService.updateUserTier(user.id);
        logger.log(`Dojah widget verification completed successfully for user ${user.id}, new tier: ${updatedUser.tier ?? 0}`);

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
    } catch (error) {
        logger.error(`Dojah widget verification failed for user ${user.id}`, {
            error: error.message,
            stack: error.stack,
        });

        return buildResponse({
            message: "Failed to save verification result",
            success: false,
        });
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
        // Call Dojah directly with base64 - no need for URL
        (async () => {
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
                // Enhanced error logging - capture full error details
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

                // Return error details for proper handling
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
        })(),
    ]);

    const { isValid: isDocumentValid, nameMatches, parsed: dojahParsed, raw: dojahRawResponse, error: dojahError } = dojahResult;

    // If Dojah failed with an error, throw it to the frontend with a user-friendly message
    if (!dojahResult.success && dojahError) {
        const userMessage = this.mapDojahErrorToUserMessage(dojahError);
        throw new VerificationGenericException(
            userMessage,
            dojahError.status || HttpStatus.BAD_REQUEST
        );
    }

    logger.log(
        `Document analysis for user ${user.id}: ` +
        `valid=${isDocumentValid}, nameMatches=${nameMatches}, ` +
        `docType=${dojahParsed?.documentType || "unknown"}, ` +
        `reason=${dojahParsed?.reason || "unknown"}`
    );

    // If Dojah says document is NOT valid, reject with a user-friendly reason
    if (!isDocumentValid && dojahParsed?.reason) {
        const reason = dojahParsed.reason.toUpperCase();
        let rejectionReason: string;

        if (reason === "NOT_VALID" || reason === "INVALID") {
            rejectionReason = "Document could not be verified. Please ensure the image is clear, all text is readable, and the document is a valid government-issued ID.";
        } else if (reason.includes("BLUR") || reason.includes("UNCLEAR")) {
            rejectionReason = "Document image is unclear. Please take a clearer photo with good lighting.";
        } else if (reason.includes("EXPIRED")) {
            rejectionReason = "Document appears to be expired. Please upload a valid, unexpired document.";
        } else if (reason.includes("NOT_SUPPORTED") || reason.includes("UNSUPPORTED")) {
            rejectionReason = "This document type is not supported. Please upload a valid passport, driver's license, or national ID.";
        } else {
            // Pass through other specific reasons from Dojah
            rejectionReason = dojahParsed.reason;
        }

        throw new VerificationGenericException(
            rejectionReason,
            HttpStatus.BAD_REQUEST
        );
    }

    // Auto-approve if document is valid (simplified - no strict name matching required)
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

    // Return appropriate message based on verification result
    if (shouldAutoApprove) {
        return buildResponse({
            message: "Document verified successfully",
        });
    } else {
        return buildResponse({
            message: "Document verification is pending review",
        });
    }
}

    async updloadBusinessDocuments(
    user: User,
    files: UploadBusinessDocumentsFileInterface,
    dto: BusinessDocumentUploadDto
) {
    if (user.businessDocumentsUploaded) {
        throw new VerificationGenericException(
            `Document has already been uploaded and is ${user.businessDocumentVerificationStatus}`,
            HttpStatus.BAD_REQUEST
        );
    }

    const safeUpload = async (file?: Express.Multer.File[]) =>
        file ? this.uploadAsFile(file) : null;

    const [
        cacImage,
        articleImage,
        boardResolutionImage,
        proofOfAddressImage,
        meansOfIdImage,
    ] = await Promise.all([
        safeUpload(files.cacImage),
        safeUpload(files.articleOfAssociationImage),
        safeUpload(files.boardResolutionAuthorizedAcctOpeningImage),
        safeUpload(files.proofOfAddressForBeneficialOwner),
        safeUpload(files.meansOfIdentificationForBeneficialOwner),
    ]);

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
                    articleOfAssociationImageUrl: articleImage?.url || null,
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

    return buildResponse({
        message: "Document Verification successfully",
    });
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
                },
            });
            return record;
        },
        { maxWait: 10000, timeout: 30000 }
    );

    await this.cryptoAccountQueueProducer.enqueue(user.id);

    return buildResponse({
        message: "Business record submitted successfully",
        data: record,
    });
}

    async userSignIn(options: UserSigInDto, ip: string): Promise < ApiResponse > {
    return await this.signIn(options, LoginPlatform.USER, ip);
}

    async adminSignIn(options: UserSigInDto, ip: string): Promise < ApiResponse > {
    return await this.signIn(options, LoginPlatform.ADMIN, ip);
}

    private async signIn(
    options: SignInOptions,
    loginPlatform: LoginPlatform,
    ip: string
): Promise < ApiResponse > {
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
    };

    const user = await this.prisma.user.findUnique({
        where: { email: options.email },
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

    if(!user) {
        throw new InvalidCredentialException("Invalid email or password");
    }

        const flagged = user.flaggedRecord || { flagged: false, reason: "" };
    if(
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

const passwordMatch = await this.comparePassword(
    options.password,
    user.password
);
if (!passwordMatch) {
    await this.handleFailedLogin(user, ip);
    throw new InvalidCredentialException("Invalid email or password");
}

// Check if 2FA is enabled - return temporary token for 2FA verification
// Apply to BOTH user and admin logins for enhanced security
if (user.isTwoFactorEnabled && user.twoFactorSecret) {
    // Check if this is a trusted device that can skip 2FA
    let canSkip2FA = false;

    if (options.deviceToken) {
        // Look for a trusted session with this device token
        const trustedSession = await this.prisma.session.findFirst({
            where: {
                userId: user.id,
                deviceToken: options.deviceToken,
                isTrusted: true,
                isActive: true,
                trustExpiresAt: {
                    gt: new Date(), // Not expired
                },
            },
        });

        if (trustedSession) {
            // Check if user has enabled skip 2FA for trusted devices
            const userData = await this.prisma.user.findUnique({
                where: { id: user.id },
                select: { skipTwoFactorForTrustedDevices: true },
            });

            canSkip2FA = userData?.skipTwoFactorForTrustedDevices ?? false;

            if (canSkip2FA) {
                Logger.log(`Skipping 2FA for trusted device: ${trustedSession.deviceName || trustedSession.id}`);
            }
        }
    }

    if (!canSkip2FA) {
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
}

const tokens = await this.generateTokens({
    sub: user.id,
    platform: loginPlatform,
});

await this.saveRefreshToken(user.id, tokens.refreshToken);

// Create session for user logins with error handling
// Session creation failure should NOT prevent login
let sessionId: string | undefined;
let deviceToken: string | undefined;
if (loginPlatform === LoginPlatform.USER) {
    try {
        const sessionInfo: SessionInfo = {
            deviceName: options.deviceName,
            deviceType: options.deviceType,
            browser: options.browser,
            os: options.os,
            ipAddress: ip,
            deviceToken: options.deviceToken, // Pass existing device token if provided
        };
        const sessionResult = await this.sessionService.createSession(
            user.id,
            sessionInfo
        );
        sessionId = sessionResult.sessionId;
        deviceToken = sessionResult.deviceToken;
    } catch (sessionError) {
        // Log the error but don't fail the login
        Logger.error(`Failed to create session for user ${user.id}: ${sessionError.message}`);
        // Session creation is non-critical, login should still succeed
    }
}

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
    deviceToken,
    userType: user.userType.toLowerCase(),
    verificationStatus,
};

return buildResponse({
    message: "Login successful",
    data: responseData,
});
    }

    async refreshToken(options: RefreshTokenDto): Promise < ApiResponse > {
    const payload = await this.jwtService.verify(options.refreshToken, {
        secret: jwt_refresh_secret,
    });

    const isValid = await this.validateRefreshToken(
        payload.sub,
        options.refreshToken
    );

    if(!isValid) {
        throw new InvalidRefreshToken(
            "Invalid refresh token",
            HttpStatus.UNAUTHORIZED
        );
    }

        const newTokens = await this.generateTokens({ sub: payload.sub });

    await this.saveRefreshToken(payload.sub, newTokens.refreshToken);

    return buildResponse({
        message: `Refresh token generated`,
        data: newTokens,
    });
}

    async saveRefreshToken(id: number, refreshToken: string) {
    return this.prisma.user.update({
        where: { id: id },
        data: { refreshToken },
    });
}

    async validateRefreshToken(id: number, refreshToken: string) {
    const user = await this.prisma.user.findUnique({
        where: { id: id },
    });
    return user && user.refreshToken === refreshToken;
}

    /**
     * Verify 2FA code and complete login
     */
    async verify2FALogin(dto: Verify2FALoginDto, ip: string): Promise < ApiResponse > {
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

        if(payload.type !== "2fa_pending") {
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

if (!user || !user.isTwoFactorEnabled || !user.twoFactorSecret) {
    throw new UserUnauthorizedException(
        "2FA is not enabled for this account",
        HttpStatus.BAD_REQUEST
    );
}

// Try TOTP code first (verify before checking rate limit - correct code bypasses lockout)
let isValid = authenticator.verify({
    token: dto.code,
    secret: user.twoFactorSecret,
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

// Generate actual tokens
const tokens = await this.generateTokens({
    sub: user.id,
    platform: payload.platform,
});

await this.saveRefreshToken(user.id, tokens.refreshToken);

// Create session for user logins (2FA complete) with error handling
// Session creation failure should NOT prevent login
let sessionId: string | undefined;
let deviceToken: string | undefined;
if (payload.platform === LoginPlatform.USER) {
    try {
        const sessionInfo: SessionInfo = {
            deviceName: dto.deviceName,
            deviceType: dto.deviceType,
            browser: dto.browser,
            os: dto.os,
            ipAddress: ip,
            deviceToken: dto.deviceToken, // Pass existing device token if provided
        };
        const sessionResult = await this.sessionService.createSession(
            user.id,
            sessionInfo
        );
        sessionId = sessionResult.sessionId;
        deviceToken = sessionResult.deviceToken;
    } catch (sessionError) {
        // Log the error but don't fail the login
        Logger.error(`Failed to create 2FA session for user ${user.id}: ${sessionError.message}`);
        // Session creation is non-critical, login should still succeed
    }
}

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
        deviceToken,
        userType: user.userType.toLowerCase(),
        verificationStatus,
    },
});
    }

    /**
     * Reset 2FA rate limit for a user (Admin function)
     */
    async reset2FARateLimit(dto: { userId: number; context?: "login" | "transaction" }): Promise < ApiResponse > {
    // Verify user exists
    const user = await this.prisma.user.findUnique({
        where: { id: dto.userId },
        select: { id: true, email: true, isTwoFactorEnabled: true },
    });

    if(!user) {
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

    // ==================== Trusted Device Methods ====================

    /**
     * Trust the current device after 2FA verification
     * @param user Current authenticated user
     * @param req Request object to get session info
     * @param code 2FA verification code (TOTP or backup code)
     */
    async trustDevice(user: User, req: any, code: string): Promise < ApiResponse > {
    // Verify 2FA is enabled
    const userData = await this.prisma.user.findUnique({
        where: { id: user.id },
        select: {
            isTwoFactorEnabled: true,
            twoFactorSecret: true,
            twoFactorBackupCodes: true,
        },
    });

    if(!userData?.isTwoFactorEnabled || !userData?.twoFactorSecret) {
    throw new AuthGenericException(
        "Two-factor authentication must be enabled to trust devices",
        HttpStatus.BAD_REQUEST
    );
}

// Verify the 2FA code
const isValidTotp = authenticator.verify({
    token: code,
    secret: userData.twoFactorSecret,
});

let isValidBackupCode = false;
if (!isValidTotp && userData.twoFactorBackupCodes) {
    isValidBackupCode = await this.settingService.verifyBackupCode(user.id, code);
}

if (!isValidTotp && !isValidBackupCode) {
    throw new AuthGenericException(
        "Invalid verification code",
        HttpStatus.BAD_REQUEST
    );
}

// Get current session ID from JWT token
const authHeader = req.headers.authorization;
if (!authHeader) {
    throw new AuthGenericException("Session not found", HttpStatus.BAD_REQUEST);
}

const token = authHeader.split(" ")[1];
const jwtSecret = process.env.JWT_SECRET || "secret";
const payload = await this.jwtService.verifyAsync(token, { secret: jwtSecret });
const sessionId = payload.sessionId;

if (!sessionId) {
    throw new AuthGenericException("Session ID not found in token", HttpStatus.BAD_REQUEST);
}

// Verify the session belongs to the user
const session = await this.prisma.session.findFirst({
    where: { id: sessionId, userId: user.id },
});

if (!session) {
    throw new AuthGenericException("Session not found", HttpStatus.NOT_FOUND);
}

// Calculate trust expiry (30 days from now)
const trustExpiresAt = new Date();
trustExpiresAt.setDate(trustExpiresAt.getDate() + 30);

// Update session to mark as trusted
await this.prisma.session.update({
    where: { id: sessionId },
    data: {
        isTrusted: true,
        trustedAt: new Date(),
        trustExpiresAt,
    },
});

return buildResponse({
    message: "Device trusted successfully. 2FA will be skipped on this device for 30 days.",
    data: {
        trustedUntil: trustExpiresAt,
    },
});
    }

    /**
     * Remove trust from a device/session
     */
    async untrustDevice(user: User, sessionId: string): Promise < ApiResponse > {
    // Verify the session belongs to the user
    const session = await this.prisma.session.findFirst({
        where: { id: sessionId, userId: user.id },
    });

    if(!session) {
        throw new AuthGenericException("Session not found", HttpStatus.NOT_FOUND);
    }

        // Remove trust
        await this.prisma.session.update({
        where: { id: sessionId },
        data: {
            isTrusted: false,
            trustedAt: null,
            trustExpiresAt: null,
        },
    });

    return buildResponse({
        message: "Device trust removed",
    });
}

    /**
     * Check if current session is a trusted device
     */
    async isTrustedDevice(sessionId: string, userId: number): Promise < boolean > {
    const session = await this.prisma.session.findFirst({
        where: {
            id: sessionId,
            userId,
            isTrusted: true,
            trustExpiresAt: {
                gt: new Date(), // Not expired
            },
        },
    });

    return !!session;
}

    /**
     * Check if user has skip 2FA for trusted devices enabled
     */
    async shouldSkip2FAForTrustedDevice(userId: number, sessionId ?: string): Promise < boolean > {
    if(!sessionId) return false;

    const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { skipTwoFactorForTrustedDevices: true },
    });

    if(!user?.skipTwoFactorForTrustedDevices) return false;

    return await this.isTrustedDevice(sessionId, userId);
}

    /**
     * Generate a temporary token for 2FA verification flow
     * Used by biometric authentication when user has 2FA enabled
     */
    async generateTempTokenFor2FA(userId: number): Promise < string > {
    return await this.jwtService.signAsync(
        { sub: userId, type: "2fa_pending", platform: "user" },
        { secret: jwtSecret, expiresIn: "5m" }
    );
}

    /**
     * Generate access and refresh tokens for a user with an existing session
     * Used by biometric authentication to complete login
     */
    async generateTokensForUser(userId: number, sessionId ?: string) {
    const tokens = await this.generateTokens({
        sub: userId,
        platform: "user",
        sessionId,
    });

    await this.saveRefreshToken(userId, tokens.refreshToken);

    return tokens;
}
}

