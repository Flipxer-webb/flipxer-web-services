import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import {
    SignUpDto,
    UserSignInAppType,
    UserSigInDto,
    SendEmailVerificationCodeDto,
    VerifyEmailOtpDto,
    CreatePasswordDto,
    BvnVerificationDto,
    VerifyPhoneOtpDto,
    SendPhoneVerificationCodeDto,
    DocumentVerificationDto,
    SubmitBusinessRecordDto,
} from "../dtos";
import * as bcrypt from "bcryptjs";
import { ApiResponse, buildResponse } from "@/utils/api-response-util";
import { PrismaService } from "@/modules/core/prisma/services";
import { EmailService } from "@/modules/core/email/services";
import { encrypt, formatName, generateId, generateRandomNum } from "@/utils";
import { customAlphabet } from "nanoid";
import { DuplicateUserException, UserNotFoundException } from "../../user";
import {
    DuplicateBvnVerificationException,
    DuplicateVerificationException,
    InvalidEmailVerificationCodeException,
    InvalidVerificationCodeException,
    VerificationCodeExpiredException,
    VerificationGenericException,
} from "../errors";
import { Prisma, Role, User, UserType } from "@prisma/client";
import { RoleNotFoundException } from "../../authorize/error";
import {
    emailTemplateConfig,
    jwt_refresh_secret,
    jwtSecret,
    mailConfig,
    REFRESH_TOKEN_EXPIRATION,
    storageDirConfig,
    TOKEN_EXPIRATION,
} from "@/config";
import { UploadResponse } from "imagekit/dist/libs/interfaces";
import { ImagekitService } from "@/modules/core/upload/services/imagekit";
import { UploadFactory } from "@/modules/core/upload/services";
import { CloudinaryService } from "@/modules/core/upload/services/cloudinary";
import { UploadApiResponse } from "cloudinary";
import { LoginPlatform, SignInOptions } from "../interfaces";

@Injectable()
export class AuthService {
    private uploadService: ImagekitService | CloudinaryService;
    private readonly logger = new Logger("AuthServices");
    constructor(
        private jwtService: JwtService,
        private prisma: PrismaService,
        private emailService: EmailService,
        private uploadFactory: UploadFactory
    ) {
        this.uploadService = this.uploadFactory.build({
            provider: "imagekit",
        });
    }

    async hashPassword(password: string): Promise<string> {
        return await bcrypt.hash(password, 10);
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

        let createUserOptions: Prisma.UserUncheckedCreateInput;

        createUserOptions = {
            email: options.email,
            identifier: generateId({ type: "identifier" }),
            userType: options.accountType,
            roleId: role.id,
            ipAddress: ip,
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

        try {
            await this.emailService.sendMailWithTemplate({
                from: { address: mailConfig.senderMail },
                to: [{ email_address: { address: options.email } }],
                template_key: emailTemplateConfig.registration_success,
                merge_info: {
                    code: verificationCode,
                    notice: "Please proceed to verify your account with the code. Accounts that are not verified after 3days will be removed from our platform. Thank you",
                },
            });
        } catch (error) {
            this.logger.error(
                "Error sending account verification email",
                error.error.details
            );
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
                merge_info: { code: verificationCode },
            });
        } catch (error) {
            this.logger.error(
                "Error sending account verification email",
                error.error.details
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

        if (
            user.userType === UserType.INDIVIDUAL &&
            user.bvnRegisteredPhone !== options.phone
        ) {
            throw new VerificationGenericException(
                "Please use the phone registered with your bvn",
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

        const phoneNumber = options.phone
            ? `234${options.phone.trim().substring(1)}`
            : null;
        // TODO: send code to phone

        return buildResponse({
            message: `A phone verification code has been sent to your phone, ${options.phone}`,
            data: {
                email: options.phone,
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

        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                firstName: dto.firstName,
                lastName: dto.lastName,
                dateOfBirth: dto.dateOfBirth,
                isBvnVerified: true,
                bvn: dto.bvn,
            },
        });
        return buildResponse({
            message: "Bvn Verification successfully",
        });
    }

    async documentVerification(user: User, dto: DocumentVerificationDto) {
        if (user.isDocumentVerified) {
            throw new VerificationGenericException(
                "Document has already been verified",
                HttpStatus.BAD_REQUEST
            );
        }

        const uploadedDoc = await this.uploadDocumentImage(
            dto.documentImageUrl
        );

        await this.prisma.$transaction(
            async (tx) => {
                await tx.userDocument.upsert({
                    where: { userId: user.id },
                    update: {},
                    create: {
                        userId: user.id,
                        type: dto.documentType,
                        country: dto.country,
                        documentNumber: dto.documentNumber,
                        documentImageUrl: uploadedDoc.url,
                        documentImageFieldId: uploadedDoc.fileId,
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

    async submitBusinessRecord(user: User, dto: SubmitBusinessRecordDto) {
        const record = await this.prisma.businessRecord.upsert({
            where: { id: user.id },
            update: {
                businessName: dto.businessName,
                natureOfBusiness: dto.natureOfBusiness,
                expectedTransactionFrequency: dto.expectedTransactionFrequency,
                expectedTransactionVolume: dto.expectedTransactionVolumes,
                taxIdentificationNumber: dto.taxIdentificationNumber,
            },
            create: {
                userId: user.id,
                businessName: dto.businessName,
                natureOfBusiness: dto.natureOfBusiness,
                expectedTransactionFrequency: dto.expectedTransactionFrequency,
                expectedTransactionVolume: dto.expectedTransactionVolumes,
                taxIdentificationNumber: dto.taxIdentificationNumber,
            },
        });

        await this.prisma.user.update({
            where: { id: user.id },
            data: { businessRecordCompleted: true },
        });

        return buildResponse({
            message: "Business record submitted successfully",
            data: record,
        });
    }

    async userSignIn(options: UserSigInDto, ip: string): Promise<ApiResponse> {
        const { userType } = options;

        if (userType === UserSignInAppType.INDIVIDUAL) {
            return this.customerSignIn(options, ip);
        } else if (userType === UserSignInAppType.BUSINESS) {
            return this.bussinessSignIn(options, ip);
        } else if (userType === UserSignInAppType.ADMIN) {
            return this.adminSignIn(options, ip);
        }

        return buildResponse({
            message: "Invalid sign-in type",
            data: {},
        });
    }

    async customerSignIn(options: UserSigInDto, ip: string): Promise<ApiResponse> {
        return await this.signIn(options, LoginPlatform.CUSTOMER, ip);
    }

    async bussinessSignIn(options: UserSigInDto, ip: string): Promise<ApiResponse> {
        return await this.signIn(options, LoginPlatform.BUSINESS, ip);
    }

    async adminSignIn(options: UserSigInDto, ip: string): Promise<ApiResponse> {
        return await this.signIn(options, LoginPlatform.ADMIN, ip);
    }

    // Updated signIn method to return both access and refresh tokens
    private async signIn(
        options: SignInOptions,
        loginPlatform: LoginPlatform,
        ip: string
    ): Promise<ApiResponse> {
        const user = await this.prisma.user.findUnique({
            where: {
                email: options.email,
            },
            select: {
                id: true, // Include id for token generation
                identifier: true,
                password: true,
            },
        });

        if (!user) {
            return buildResponse({
                success: false,
                message: "User not found",
                data: {},
            });
        }

        const passwordMatch = await this.comparePassword(options.password, user.password);
        if (!passwordMatch) {
            return buildResponse({
                success: false,
                message: "Incorrect password",
                data: {},
            });
        }

        // Generate both access and refresh tokens
        const tokens = await this.generateTokens({
            sub: user.id, // Use id instead of identifier for consistency
            platform: loginPlatform,
        });

        // Update user's last login IP
        await this.prisma.user.update({
            where: { id: user.id },
            data: { ipAddress: ip },
        });

        return buildResponse({
            message: "Login successful",
            data: {
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
            },
        });
    }
}