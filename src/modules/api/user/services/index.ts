import { storageDirConfig } from "@/config";
import { EmailService } from "@/modules/core/email/services";
import { PrismaService } from "@/modules/core/prisma/services";
import {
    buildPaginationMeta,
    defaultPagination,
    generateRandomNum,
} from "@/utils";
import {
    Injectable,
    forwardRef,
    Inject,
    HttpStatus,
    Logger,
} from "@nestjs/common";
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
import { QuidaxCacheService } from "@/modules/core/redisCache/services/quidax-cache.service";
import { AssetWallet, Prisma, User } from "@prisma/client";
import { DuplicateUserException, IncorrectPasswordException } from "../errors";
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
        private uploadFactory: UploadFactory,
        private readonly quidaxCacheService: QuidaxCacheService
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

        const resolvedPageNumber =
            !pageNumber || pageNumber <= 1
                ? defaultPagination.pageNumber
                : pageNumber;

        const resolvedPageSize =
            !pageSize || pageSize <= 0 ? defaultPagination.pageSize : pageSize;

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

        // Step 1: Fetch user assets + count
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

        // Step 2: Fetch admin-defined crypto rates (e.g., BTC, USDT)
        const adminRates = await this.prisma.cryptoRate.findMany();
        const adminRatesMap = new Map(
            adminRates.map((rate) => [rate.currency.toLowerCase(), rate])
        );

        // Step 3: Fetch live Quidax rates
        const liveMarketData = await this.quidaxCacheService.getMarketTickers();
        const referenceCurrency = "ngn"; // Change to 'usdt' or dynamic as needed

        console.log(liveMarketData, "liveMarketData");

        // Step 4: Merge data into asset response
        const responseData: DataWithPagination<any> = {
            ...(query.paginated === "true" && {
                meta: buildPaginationMeta(
                    resolvedPageNumber,
                    resolvedPageSize,
                    count,
                    assets.length
                ),
            }),
            records: assets.map((asset) => {
                const assetCurrency = asset.assetCurrency.toLowerCase();

                // Admin rate lookup
                const adminRate = adminRatesMap.get(assetCurrency);
                const adminBuyRate = adminRate?.buyRate ?? 0;
                const adminSellRate = adminRate?.sellRate ?? 0;

                // Live market data lookup
                const marketSymbol = `${assetCurrency}${referenceCurrency}`;
                const ticker = liveMarketData?.[marketSymbol]?.ticker;

                return {
                    ...asset,
                    buyRate: {
                        value: adminBuyRate.toFixed(4),
                        referenceCurrency,
                    },
                    sellRate: {
                        value: adminSellRate.toFixed(4),
                        referenceCurrency,
                    },
                    liveRate: {
                        buy: ticker?.buy ?? null,
                        sell: ticker?.sell ?? null,
                        last: ticker?.last ?? null,
                        referenceCurrency,
                    },
                };
            }),
        };

        return {
            message: "Assets successfully retrieved",
            data: responseData,
        };
    }

    private async uploadProfileImage(
        file: Express.Multer.File
    ): Promise<UploadApiResponse | UploadResponse> {
        const date = Date.now();
        return await this.uploadService.uploadCompressedImage({
            dir: storageDirConfig.profile,
            name: `profile-image-${date}-${generateRandomNum(5)}`,
            format: "webp",
            body: file.buffer, // Use file buffer directly
            quality: 100,
            width: 320,
            type: "image",
        });
    }

    async updateUserDetails(
        options: UpdateUserDetailsDto,
        user: User,
        photo?: Express.Multer.File
    ) {
        const profileUpdateOptions: Prisma.UserUncheckedUpdateInput = {
            firstName: options.firstName ?? user.firstName,
            lastName: options.lastName ?? user.lastName,
            phone: options.phone ?? user.phone,
            gender: options.gender ?? user.gender,
            country: options.country ?? user.country,
            dateOfBirth: new Date(options.dateOfBirth) ?? user.dateOfBirth,
        };

        if (options.phone) {
            const phoneExist = await this.prisma.user.findFirst({
                where: { id: { not: user.id }, phone: options.phone },
            });
            if (phoneExist) {
                throw new DuplicateUserException(
                    "Phone already in use by another",
                    HttpStatus.BAD_REQUEST
                );
            }
        }

        if (photo) {
            const uploadResponse = await this.uploadProfileImage(photo);
            if (user?.photoFileId) {
                try {
                    await this.uploadService.removeImage({
                        fileId: user.photoFileId,
                        key: process.env.IMAGEKIT_PRIVATE_KEY,
                    });
                } catch (error) {
                    Logger.error(
                        `Failed to delete image ${user.photoFileId}:`,
                        error
                    );
                }
            }
            profileUpdateOptions.photo = uploadResponse.url;
            profileUpdateOptions.photoFileId = uploadResponse.fileId;
        }

        const updatedUser = await this.prisma.user.update({
            where: { id: user.id },
            data: profileUpdateOptions,
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
        const isMatched = await this.authService.comparePassword(
            options.oldPassword,
            user.password
        );

        if (!isMatched) {
            throw new IncorrectPasswordException(
                "The old password you entered does not match with your existing password",
                HttpStatus.BAD_REQUEST
            );
        }

        const newHashedPassword = await this.authService.hashPassword(
            options.newPassword
        );

        await this.prisma.user.update({
            where: { id: user.id },
            data: { password: newHashedPassword },
        });

        return {
            message: "Password successfully updated",
        };
    }

    async sendRecoveryEmailOtp(
        dto: SendRecoveryEmailOtpDto,
        user: User
    ): Promise<{ message: string }> {
        // Generate 6-digit OTP
        const verificationCode = customAlphabet("1234567890", 6)();

        // Upsert the recovery email verification request
        await this.prisma.recoveryEmailVerificationRequest.upsert({
            where: {
                userId: user.id,
            },
            update: {
                email: dto.email,
                code: verificationCode,
            },
            create: {
                userId: user.id,
                email: dto.email,
                code: verificationCode,
            },
        });

        // Prepare email data
        const name =
            `${user.firstName || ""} ${user.lastName || ""}`.trim() || "User";
        const team = COMPANY_NAME;
        const notice =
            "Please use this code to verify your recovery email. The code expires in 30 minutes.";

        try {
            await this.emailService.sendMailWithTemplate({
                from: { address: mailConfig.senderMail },
                to: [{ email_address: { address: user.email } }],
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
            throw new AuthGenericException(
                "Failed to send recovery email OTP",
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }

        return {
            message: `A verification code has been sent to ${user.email}`,
        };
    }

    async verifyRecoveryEmailOtp(
        dto: VerifyRecoveryEmailOtpDto,
        user: User
    ): Promise<{ message: string }> {
        const verificationData =
            await this.prisma.recoveryEmailVerificationRequest.findFirst({
                where: {
                    userId: user.id,
                    code: dto.otp,
                },
            });

        if (!verificationData) {
            throw new InvalidVerificationCodeException(
                "Invalid verification code",
                HttpStatus.BAD_REQUEST
            );
        }

        if (verificationData.isVerified) {
            throw new DuplicateVerificationException(
                "Recovery email already verified",
                HttpStatus.BAD_REQUEST
            );
        }

        const timeDifference =
            Date.now() - verificationData.updatedAt.getTime();
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
                where: { id: verificationData.id },
            }),
        ]);

        return {
            message: "Recovery email verified successfully",
        };
    }
}
