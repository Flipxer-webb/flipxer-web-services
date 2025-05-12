import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
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
    SendForgotPasswordDto,
    ResetPasswordDto,
    RefreshTokenDto,
    BusinessDocumentUploadDto,
} from "../dtos";
import * as bcrypt from "bcryptjs";
import { ApiResponse, buildResponse } from "@/utils/api-response-util";
import { PrismaService } from "@/modules/core/prisma/services";
import { EmailService } from "@/modules/core/email/services";
import { generateId, generateRandomNum } from "@/utils";
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
import { IdentityComplianceInjectionToken } from "@/modules/factory/identityCompliance/types";
import { DojahService } from "@/modules/factory/identityCompliance/providers/dojah/services";
import { LoginPlatform, SignInOptions } from "../interfaces";
import { CryptoAccountQueueProducer } from "../../trade/queues/producers/producer.service";
import * as crypto from "crypto";
import { COMPANY_NAME } from "@/config";

@Injectable()
export class AuthService {
    private uploadService: ImagekitService | CloudinaryService;
    private readonly logger = new Logger("AuthServices");
    private readonly SALT_ROUNDS = 10;

    constructor(
        private jwtService: JwtService,
        private prisma: PrismaService,
        private emailService: EmailService,
        private uploadFactory: UploadFactory,
        @Inject(IdentityComplianceInjectionToken.DOJAH)
        private readonly dojahService: DojahService,
        private readonly cryptoAccountQueueProducer: CryptoAccountQueueProducer
    ) {
        this.uploadService = this.uploadFactory.build({
            provider: "imagekit",
        });
    }

    async hashPassword(password: string): Promise<string> {
        return await bcrypt.hash(password, this.SALT_ROUNDS);
    }

    async comparePassword(password: string, hash: string): Promise<boolean> {
        return await bcrypt.compare(password, hash);
    }

    validateAdminAccount(userType: UserType) {
        const adminUserTypes: UserType[] = [UserType.ADMIN];

        if (!adminUserTypes.includes(userType)) {
            throw new InvalidCredentialException(
                "Incorrect email or password",
                HttpStatus.UNAUTHORIZED
            );
        }
    }

    validateUserAccount(userType: UserType) {
        const userTypes: UserType[] = [UserType.INDIVIDUAL, UserType.BUSINESS];

        if (!userTypes.includes(userType)) {
            throw new InvalidCredentialException(
                "Incorrect email or password",
                HttpStatus.UNAUTHORIZED
            );
        }
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
        this.logger.debug(
            `Initiating password reset request for email: ${dto.email}`
        );

        // Check for user existence
        this.logger.debug(`Looking up user with email: ${dto.email}`);
        const user = await this.prisma.user.findUnique({
            where: { email: dto.email },
        });
        if (!user) {
            this.logger.warn(
                `Password reset requested for non-existent user: ${dto.email}`
            );
            throw new UserNotFoundException();
        }
        this.logger.debug(`User found: ${user.id} (${dto.email})`);

        // Generate reset code
        this.logger.debug(`Generating reset code for user: ${dto.email}`);
        const code = crypto.randomBytes(3).toString("hex").toUpperCase();
        this.logger.debug(`Generated reset code: ${code}`);

        // Delete any previous reset requests
        this.logger.debug(
            `Deleting existing password reset requests for user: ${user.id}`
        );
        await this.prisma.passwordResetRequest.deleteMany({
            where: { userId: user.id },
        });
        this.logger.debug(
            `Deleted existing password reset requests for user: ${user.id}`
        );

        // Create new password reset request
        this.logger.debug(
            `Creating new password reset request for user: ${user.id}`
        );
        await this.prisma.passwordResetRequest.create({
            data: {
                userId: user.id,
                code: code,
                createdAt: new Date(),
                updatedAt: new Date(),
            },
        });
        this.logger.debug(
            `Created password reset request for user: ${user.id} with code: ${code}`
        );

        // Prepare email data
        const name =
            `${user.firstName || ""} ${user.lastName || ""}`.trim() || "User";
        const productName = "products";
        const username = user.email;
        const team = COMPANY_NAME;
        const resetLink = `https://your-app.com/reset-password?code=${code}&email=${dto.email}`;
        this.logger.debug(
            `Preparing email for ${dto.email}: name=${name}, resetLink=${resetLink}`
        );

        // Send email
        this.logger.debug(`Sending password reset email to: ${dto.email}`);
        try {
            await this.emailService.sendMailWithTemplate({
                from: { address: mailConfig.senderMail },
                to: [{ email_address: { address: dto.email } }],
                template_key: emailTemplateConfig.forgot_password,
                merge_info: {
                    name,
                    product_name: productName,
                    username,
                    team,
                    reset_link: resetLink,
                },
            });
            this.logger.log(
                `Password reset email sent successfully to ${dto.email}`
            );
        } catch (error) {
            this.logger.error(
                `Failed to send password reset email to ${dto.email}`,
                error instanceof Error ? error.stack : String(error)
            );
            throw new Error("Failed to send password reset email");
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
            this.logger.warn(
                `Invalid password reset request for user: ${dto.email}`
            );
            throw new InvalidResetRequestException();
        }

        if (user.passwordResetRequest.code !== dto.resetCode) {
            this.logger.warn(`Invalid reset code for user: ${dto.email}`);
            throw new InvalidResetCodeException();
        }

        const createdAt = user.passwordResetRequest.createdAt;
        if (Date.now() - createdAt.getTime() > 30 * 60 * 1000) {
            await this.prisma.passwordResetRequest.delete({
                where: { userId: user.id },
            });
            this.logger.warn(`Expired reset code for user: ${dto.email}`);
            throw new ResetCodeExpiredException();
        }

        const hashedPassword = await this.hashPassword(dto.password);

        await this.prisma.user.update({
            where: { id: user.id },
            data: { password: hashedPassword, updatedAt: new Date() },
        });

        await this.prisma.passwordResetRequest.delete({
            where: { userId: user.id },
        });
        this.logger.log(`Password reset successfully for user: ${dto.email}`);

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

        //save the refresh token
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
                merge_info: {
                    code: verificationCode,
                    product_name: COMPANY_NAME,
                    team: COMPANY_NAME,
                },
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

        // if (
        //     user.userType === UserType.INDIVIDUAL &&
        //     user.bvnRegisteredPhone !== options.phone
        // ) {
        //     throw new VerificationGenericException(
        //         "Please use the phone registered with your bvn",
        //         HttpStatus.BAD_REQUEST
        //     );
        // }

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

        //check if bvn is already in use by another account
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
            bvn: dto.bvn, //22222222222 sandbox bvn
        });

        if (dto.bvn === "22222222222") {
            //sandbox mode
            await this.prisma.user.update({
                where: { id: user.id },
                data: {
                    firstName: dto.firstName,
                    lastName: dto.lastName,
                    dateOfBirth: new Date(dto.dateOfBirth),
                    isBvnVerified: true,
                    bvn: generateId({ type: "numeric" }),
                    //phone:''
                },
            });
        } else {
            //cross check the names and dob
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

        //create user quidax account and default wallet address once email is verified
        await this.cryptoAccountQueueProducer.enqueue(user.id);

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

        //todo: verify document number using the verification API

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

    async uploadAsFile(file: Express.Multer.File) {
        console.log(file, "file");
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
        files: any,
        dto: BusinessDocumentUploadDto
    ) {
        if (user.businessDocumentsUploaded) {
            throw new VerificationGenericException(
                `Document has already been upload and is ${user.businessDocumentVerificationStatus}`,
                HttpStatus.BAD_REQUEST
            );
        }

        // Upload all images concurrently
        const [
            cacImage,
            articleImage,
            boardResolutionImage,
            proofOfAddressImage,
            meansOfIdImage,
        ] = await Promise.all([
            this.uploadAsFile(files.cacImage),
            this.uploadAsFile(files.articleOfAssociationImage),
            this.uploadAsFile(files.boardResolutionAuthorizedAcctOpeningImage),
            this.uploadAsFile(files.proofOfAddressForBeneficialOwner),
            this.uploadAsFile(files.meansOfIdentificationForBeneficialOwner),
        ]);

        await this.prisma.$transaction(
            async (tx) => {
                await tx.businessDocument.upsert({
                    where: { userId: user.id },
                    update: {},
                    create: {
                        userId: user.id,
                        cacDocumentNumber: dto.cacDocumentNumber,
                        cacImageUrl: cacImage.url,
                        cacImageUrlFieldId: cacImage.fileId,
                        articleOfAssociationNumber:
                            dto.articleOfAssociationNumber,
                        articleOfAssociationImageUrl: articleImage.url,
                        articleOfAssociationImageUrlFieldId:
                            articleImage.fileId,
                        boardResolutionAuthorizedAcctOpeningImageUrl:
                            boardResolutionImage.url,
                        boardResolutionAuthorizedAcctOpeningImageUrlFieldId:
                            boardResolutionImage.fileId,
                        meansOfIdentificationForBeneficialOwner:
                            meansOfIdImage.url,
                        meansOfIdentificationForBeneficialOwnerImageFieldId:
                            meansOfIdImage.fileId,
                        proofOfAddressForBeneficialOwner:
                            proofOfAddressImage.url,
                        proofOfAddressForBeneficialOwnerImageFieldId:
                            proofOfAddressImage.fileId,
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
        //todo: taxid verification
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
        const user = await this.prisma.user.findUnique({
            where: {
                email: options.email,
            },
            select: {
                id: true,
                identifier: true,
                password: true,
                userType: true,
                status: true,
                role: { select: { name: true, rolePermission: true } },
            },
        });

        if (!user) {
            throw new InvalidCredentialException();
        }

        //check that user account is not blocked
        if (user.status == Status.BLOCKED) {
            throw new UserAccountDisabledException(
                "Account is disabled. Kindly contact customer support",
                HttpStatus.BAD_REQUEST
            );
        }

        //check that user is login to right platform
        switch (loginPlatform) {
            case LoginPlatform.ADMIN: {
                this.validateAdminAccount(user.userType);
                break;
            }
            case LoginPlatform.USER: {
                this.validateUserAccount(user.userType);
                break;
            }

            default: {
                throw new AuthGenericException(
                    "Invalid login platform",
                    HttpStatus.INTERNAL_SERVER_ERROR
                );
            }
        }

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
            throw new InvalidCredentialException();
        }

        const tokens = await this.generateTokens({
            sub: user.id,
            platform: loginPlatform,
        });

        //save the refresh token
        await this.saveRefreshToken(user.id, tokens.refreshToken);

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

    async refreshToken(options: RefreshTokenDto): Promise<ApiResponse> {
        // Verify the refresh token
        const payload = await this.jwtService.verify(options.refreshToken, {
            secret: jwt_refresh_secret,
        });

        // Validate against stored refresh token
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

        // Generate new tokens
        const newTokens = await this.generateTokens({ sub: payload.sub });

        // Optionally update the stored refresh token (rotate)
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
}
