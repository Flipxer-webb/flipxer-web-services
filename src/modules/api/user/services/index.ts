import { storageDirConfig } from "@/config";
import { EmailService } from "@/modules/core/email/services";
import { PrismaService } from "@/modules/core/prisma/services";
import {
    buildPaginationMeta,
    defaultPagination,
    generateRandomNum,
} from "@/utils";
import { Injectable, forwardRef, Inject, HttpStatus } from "@nestjs/common";
import { AuthService } from "../../auth/services";
import { UploadFactory } from "@/modules/core/upload/services";
import { CloudinaryService } from "@/modules/core/upload/services/cloudinary";
import { UploadApiResponse } from "cloudinary";
import { ImagekitService } from "@/modules/core/upload/services/imagekit";
import { UploadResponse } from "imagekit/dist/libs/interfaces";
import {
    GetUserAssetsDto,
    UpdateProfilePasswordDto,
    UpdateUserDetailsDto,
    SendRecoveryEmailOtpDto,
    VerifyRecoveryEmailOtpDto,
} from "../dtos";
import { UserNotFoundException, AuthGenericException } from "../../auth/errors";
import { AssetWallet, Prisma, User } from "@prisma/client";
import { IncorrectPasswordException } from "../errors";
import { customAlphabet } from "nanoid";
import { emailTemplateConfig, COMPANY_NAME, mailConfig } from "@/config";
import {
    InvalidVerificationCodeException,
    VerificationCodeExpiredException,
    DuplicateVerificationException,
} from "../../auth/errors";

@Injectable()
export class UserService {
    private uploadService: ImagekitService | CloudinaryService;

    constructor(
        private prisma: PrismaService,
        @Inject(forwardRef(() => AuthService))
        private authService: AuthService,
        private emailService: EmailService,
        private uploadFactory: UploadFactory
    ) {
        this.uploadService = this.uploadFactory.build({
            provider: "imagekit",
        });
    }

    async getProfile(user: User) {
        const profile = await this.prisma.user.findUnique({
            where: { id: user.id },
            select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                photo: true,
                phone: true,
                userType: true,
                gender: true,
                dateOfBirth: true,
                country: true,
                status: true,
                isEmailVerified: true,
                isPhoneVerified: true,
                isPasswordCreated: true,
                isBvnVerified: true,
                isDocumentVerified: true,
                businessRecordCompleted: true,
                businessDocumentVerificationStatus: true,
                accountLimit: {
                    select: {
                        buyToken: true,
                        receiveToken: true,
                        sellTokenFiat: true,
                        sendToken: true,
                        swapToken: true,
                    },
                },
            },
        });

        const defaultWallet = await this.prisma.assetWallet.findFirst({
            where: {
                userId: user.id,
                assetCurrency: "USDT",
            },
            select: {
                assetCurrency: true,
                defaultNetwork: true,
                depositAddress: true,
                destinationTag: true,
                user: {
                    select: {
                        firstName: true,
                        lastName: true,
                    },
                },
            },
        });

        return {
            message: "Profile successfully retrieved",
            data: {
                ...profile,
                assetWallet: defaultWallet,
            },
        };
    }

    async getUserAggregatedWalletBalance(user: User) {
        const result = await this.prisma.assetWallet.aggregate({
            where: { userId: user.id },
            _sum: {
                convertedBalance: true,
            },
        });

        return {
            message: "Aggregated wallet balance retrieved",
            data: {
                total: result._sum.convertedBalance ?? 0,
                referenceCurrency: "ngn",
            },
        };
    }

    async getUserWallets(user: User, query: GetUserAssetsDto) {
        const { pageNumber, pageSize, sortBy } = query;

        const resolvedPageNumber: number =
            !pageNumber || (pageNumber && pageNumber <= 1)
                ? defaultPagination.pageNumber
                : pageNumber;

        const resolvedPageSize: number =
            !pageSize || (pageSize && pageSize <= 0)
                ? defaultPagination.pageSize
                : query.pageSize;

        const dbQuery: Prisma.AssetWalletFindManyArgs = {
            orderBy: { createdAt: sortBy },
            where: {
                userId: user.id,
                ...(query.searchText && {
                    OR: [
                        {
                            assetName: {
                                contains: query.searchText,
                                mode: "insensitive",
                            },
                        },
                        {
                            assetCurrency: {
                                contains: query.searchText,
                                mode: "insensitive",
                            },
                        },
                    ],
                }),
            },
        };

        const [assets, count] = await this.prisma.$transaction([
            this.prisma.assetWallet.findMany({
                ...dbQuery,
                ...(query.paginated === "true" && {
                    skip: (resolvedPageNumber - 1) * resolvedPageSize,
                    take: resolvedPageSize,
                }),
            }),
            this.prisma.assetWallet.count({ where: dbQuery.where }),
        ]);

        // Buy and sell rate to come from admin settings
        const buyRate = 0.0;
        const sellRate = 0.0;

        const responseData: DataWithPagination<AssetWallet> = {
            ...(query.paginated === "true" && {
                meta: buildPaginationMeta(
                    resolvedPageNumber,
                    resolvedPageSize,
                    count,
                    assets.length
                ),
            }),
            records: assets.map((asset) => ({
                ...asset,
                buyRate: {
                    value: buyRate.toFixed(4),
                    referenceCurrency: "ngn",
                },
                sellRate: {
                    value: sellRate.toFixed(4),
                    referenceCurrency: "ngn",
                },
            })),
        };

        return {
            message: "Assets successfully retrieved",
            data: responseData,
        };
    }

    private async uploadProfileImage(file: Express.Multer.File): Promise<UploadApiResponse | UploadResponse> {
        const date = Date.now();
        return await this.uploadService.uploadCompressedImage({
            dir: storageDirConfig.profile,
            name: `profile-image-${date}-${generateRandomNum(5)}`,
            format: "webp",
            body: file.buffer,
            quality: 100,
            width: 320,
            type: "image",
        });
    }

    async updateUserDetails(dto: UpdateUserDetailsDto, user: User, photo?: Express.Multer.File) {
        const currentUser = await this.prisma.user.findUnique({
            where: { id: user.id },
            select: { photo: true, photoFileId: true },
        });

        let photoUrl: string | null = null;
        let photoFileId: string | null = null;

        if (photo) {
            const uploadResponse = await this.uploadProfileImage(photo);

            if ("url" in uploadResponse && "fileId" in uploadResponse) {
                photoUrl = uploadResponse.url;
                photoFileId = uploadResponse.fileId;

                if (currentUser?.photoFileId) {
                    if (!process.env.IMAGEKIT_PRIVATE_KEY) {
                        throw new Error("ImageKit private key is not configured");
                    }
                    try {
                        await this.uploadService.removeImage({
                            fileId: currentUser.photoFileId,
                            key: process.env.IMAGEKIT_PRIVATE_KEY,
                        });
                    } catch (error) {
                        console.error(`Failed to delete image ${currentUser.photoFileId}:`, error);
                    }
                }
            }
        }

        const updatedUser = await this.prisma.user.update({
            where: { id: user.id },
            data: {
                firstName: dto.firstName,
                lastName: dto.lastName,
                phone: dto.phone,
                gender: dto.gender,
                dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
                country: dto.country,
                photo: photoUrl,
                photoFileId: photoFileId,
            },
            select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                photo: true,
                phone: true,
                gender: true,
                dateOfBirth: true,
                country: true,
            },
        });

        return {
            message: "User details updated successfully",
            data: updatedUser,
        };
    }

    async updateProfilePassword(options: UpdateProfilePasswordDto, user: User) {
        const userData = await this.prisma.user.findUnique({
            where: { id: user.id },
        });

        if (!userData) {
            throw new UserNotFoundException("User profile could not be found", HttpStatus.NOT_FOUND);
        }

        const isMatched = await this.authService.comparePassword(options.oldPassword, userData.password);

        if (!isMatched) {
            throw new IncorrectPasswordException(
                "The old password you entered does not match with your existing password",
                HttpStatus.BAD_REQUEST
            );
        }

        const newHashedPassword = await this.authService.hashPassword(options.newPassword);

        await this.prisma.user.update({
            where: { id: user.id },
            data: { password: newHashedPassword },
        });

        return {
            message: "Password successfully updated",
        };
    }

   async sendRecoveryEmailOtp(dto: SendRecoveryEmailOtpDto, user: User): Promise<{ message: string }> {
    const currentUser = await this.prisma.user.findUnique({
        where: { id: user.id },
    });

    if (!currentUser) {
        throw new UserNotFoundException("User not found", HttpStatus.NOT_FOUND);
    }

    // Generate 6-digit OTP
    const verificationCode = customAlphabet("1234567890", 6)();

    // Delete any existing recovery email verification request for this user
    await this.prisma.recoveryEmailVerificationRequest.deleteMany({
        where: { userId: user.id },
    });

    // Create a new recovery email verification request
    await this.prisma.recoveryEmailVerificationRequest.create({
        data: {
            userId: user.id,
            email: dto.email,
            code: verificationCode,
        },
    });

    // Prepare email data
    const name = `${currentUser.firstName || ""} ${currentUser.lastName || ""}`.trim() || "User";
    const team = COMPANY_NAME;
    const notice = "Please use this code to verify your recovery email. The code expires in 30 minutes.";

    try {
        await this.emailService.sendMailWithTemplate({
            from: { address: mailConfig.senderMail },
            to: [{ email_address: { address: currentUser.email } }],
            template_key: emailTemplateConfig.recovery_pin,
            merge_info: {
                name,
                code: verificationCode,
                notice,
                team,
            },
        });
    } catch (error) {
        console.error(`Failed to send recovery email OTP: ${error}`);
        throw new AuthGenericException("Failed to send recovery email OTP", HttpStatus.INTERNAL_SERVER_ERROR);
    }

    return {
        message: `A verification code has been sent to ${currentUser.email}`,
    };
}

    async verifyRecoveryEmailOtp(dto: VerifyRecoveryEmailOtpDto, user: User): Promise<{ message: string }> {
        const currentUser = await this.prisma.user.findUnique({
            where: { id: user.id },
        });

        if (!currentUser) {
            throw new UserNotFoundException("User not found", HttpStatus.NOT_FOUND);
        }

        const verificationData = await this.prisma.recoveryEmailVerificationRequest.findUnique({
            where: {
                userId_code: { userId: user.id, code: dto.otp },
            },
        });

        if (!verificationData) {
            throw new InvalidVerificationCodeException("Invalid verification code", HttpStatus.BAD_REQUEST);
        }

        if (verificationData.isVerified) {
            throw new DuplicateVerificationException("Recovery email already verified", HttpStatus.BAD_REQUEST);
        }

        const timeDifference = Date.now() - verificationData.updatedAt.getTime();
        const timeDiffInMin = timeDifference / (1000 * 60);

        if (timeDiffInMin > 30) {
            throw new VerificationCodeExpiredException(
                "Your verification code has expired. Kindly request a new one",
                HttpStatus.BAD_REQUEST
            );
        }

        // Update user with verified recovery email and delete the verification request
        await this.prisma.$transaction([
            this.prisma.user.update({
                where: { id: user.id },
                data: { recoveryEmail: verificationData.email },
            }),
            this.prisma.recoveryEmailVerificationRequest.delete({
                where: { userId_code: { userId: user.id, code: dto.otp } },
            }),
        ]);

        return {
            message: "Recovery email verified successfully",
        };
    }
}