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

@Injectable()
export class AuthService {
    private uploadService: ImagekitService | CloudinaryService;
    private readonly SALT_ROUNDS = 10;

    constructor(
        private jwtService: JwtService,
        private prisma: PrismaService,
        private emailService: EmailService,
        private uploadFactory: UploadFactory,
        @Inject(IdentityComplianceInjectionToken.DOJAH)
        private readonly dojahService: DojahService,
        private readonly cryptoAccountQueueProducer: CryptoAccountQueueProducer,
        private readonly smsService: SmsService
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
        const user = await this.prisma.user.findUnique({
            where: { email: options.email.trim() },
        });

        if (user) {
            throw new DuplicateUserException(
                "An account with this email already exist. Please login",
                HttpStatus.BAD_REQUEST
            );
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

        try {
            await this.emailService.sendMailWithTemplate({
                from: { address: mailConfig.senderMail },
                to: [{ email_address: { address: options.email } }],
                template_key: emailTemplateConfig.registration_success,
                merge_info: {
                    team: COMPANY_NAME,
                    header: "Registration Code",
                    code: verificationCode,
                    notice: "Please proceed to verify your account with the code. Accounts that are not verified after 3days will be removed from our platform. Thank you",
                },
            });
        } catch (error) {
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
    ): Promise<ApiResponse> {
        const verificationCode = customAlphabet("1234567890", 6)();
        const email = options.email.toLowerCase().trim();

        const emailExist = await this.prisma.user.findUnique({
            where: { email: email },
            select: { id: true, isEmailVerified: true },
        });

        if (!emailExist) {
            throw new UserNotFoundException(
                "Account with email not found. Kindly register first",
                HttpStatus.BAD_REQUEST
            );
        }

        if (emailExist && emailExist.isEmailVerified) {
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
                    code: verificationCode,
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

    async verifyEmailOtp(options: VerifyEmailOtpDto): Promise<ApiResponse> {
        const emailExist = await this.prisma.user.findUnique({
            where: { email: options.email },
            select: { id: true, isEmailVerified: true },
        });

        if (!emailExist) {
            throw new UserNotFoundException(
                "Account with email not found. Kindly register first",
                HttpStatus.BAD_REQUEST
            );
        }

        if (emailExist && emailExist.isEmailVerified) {
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
            data: { isEmailVerified: true },
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
            data: { isPhoneVerified: true },
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
        if (user.isDocumentVerified) {
            throw new VerificationGenericException(
                "Document has already been verified",
                HttpStatus.BAD_REQUEST
            );
        }

        const documentImage1Promise = this.uploadAsFile(files.documentImage1);
        const documentImage2Promise = files.documentImage2
            ? this.uploadAsFile(files.documentImage2)
            : Promise.resolve(null);

        const [documentImage1, documentImage2] = await Promise.all([
            documentImage1Promise,
            documentImage2Promise,
        ]);

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
                    },
                });

                await tx.user.update({
                    where: { id: user.id },
                    data: { isDocumentVerified: true },
                });
            },
            { timeout: 30000 }
        );

        return buildResponse({
            message: "Document Verification successfully",
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

        if (!user) {
            throw new InvalidCredentialException("Invalid email or password");
        }

        const flagged = user.flaggedRecord || { flagged: false, reason: "" };
        if (
            flagged.flagged &&
            flagged.reason === "Multiple failed login attempts"
        ) {
            throw new UserAccountDisabledException(
                `Account is flagged: ${
                    flagged.reason || "Multiple failed login attempts"
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
        if (user.isTwoFactorEnabled && user.twoFactorSecret && loginPlatform === LoginPlatform.USER) {
            const tempToken = await this.jwtService.signAsync(
                { sub: user.id, type: "2fa_pending", platform: loginPlatform },
                { secret: jwtSecret, expiresIn: "5m" }
            );

            return buildResponse({
                message: "Two-factor authentication required",
                data: {
                    requiresTwoFactor: true,
                    tempToken: tempToken,
                },
            });
        }

        const tokens = await this.generateTokens({
            sub: user.id,
            platform: loginPlatform,
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
            userType: user.userType.toLowerCase(),
            verificationStatus,
        };

        return buildResponse({
            message: "Login successful",
            data: responseData,
        });
    }

    async refreshToken(options: RefreshTokenDto): Promise<ApiResponse> {
        const payload = await this.jwtService.verify(options.refreshToken, {
            secret: jwt_refresh_secret,
        });

        const isValid = await this.validateRefreshToken(
            payload.sub,
            options.refreshToken
        );

        if (!isValid) {
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

        if (!user || !user.isTwoFactorEnabled || !user.twoFactorSecret) {
            throw new UserUnauthorizedException(
                "2FA is not enabled for this account",
                HttpStatus.BAD_REQUEST
            );
        }

        // Verify TOTP code
        const isValid = authenticator.verify({
            token: dto.code,
            secret: user.twoFactorSecret,
        });

        if (!isValid) {
            throw new InvalidCredentialException("Invalid verification code");
        }

        // Generate actual tokens
        const tokens = await this.generateTokens({
            sub: user.id,
            platform: payload.platform,
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
                userType: user.userType.toLowerCase(),
                verificationStatus,
            },
        });
    }
}
