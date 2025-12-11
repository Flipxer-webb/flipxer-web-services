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
import { TierService } from "../../auth/services/tier.service";
import { UploadFactory } from "@/modules/core/upload/services";
import { CloudinaryService } from "@/modules/core/upload/services/cloudinary";
import { ImagekitService } from "@/modules/core/upload/services/imagekit";
import { UploadApiResponse } from "cloudinary";
import { UploadResponse } from "imagekit/dist/libs/interfaces";
import {
    GetUserAssetsDto,
    UpdateProfilePasswordDto,
    UpdateUserDetailsDto,
    SendRecoveryEmailOtpDto,
    VerifyRecoveryEmailOtpDto,
    GetUserListDto,
} from "../dtos";
import { UserNotFoundException, AuthGenericException } from "../../auth/errors";
import { QuidaxCacheService } from "@/modules/core/redisCache/services/quidax-cache.service";
import { AssetWallet, OrderStatus, Prisma, User } from "@prisma/client";
import { DuplicateUserException, IncorrectPasswordException } from "../errors";
import { customAlphabet } from "nanoid";
import { emailTemplateConfig, COMPANY_NAME, mailConfig } from "@/config";
import {
    InvalidVerificationCodeException,
    VerificationCodeExpiredException,
    DuplicateVerificationException,
} from "../../auth/errors";
import { Ticker } from "@/libs/quidax/types/trade";
import { CoinGeckoCacheService } from "@/modules/core/redisCache/services/coingecko-cache.service";
import { SupportedAssets } from "@/modules/api/trade/interfaces/trade";

@Injectable()
export class UserService {
    private uploadService: ImagekitService | CloudinaryService;
    private readonly logger = new Logger(UserService.name);

    constructor(
        private prisma: PrismaService,
        @Inject(forwardRef(() => AuthService))
        private authService: AuthService,
        private emailService: EmailService,
        private uploadFactory: UploadFactory,
        private readonly quidaxCacheService: QuidaxCacheService,
        private readonly tierService: TierService,
        private readonly coinGeckoCacheService: CoinGeckoCacheService
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
                recoveryEmail: true,
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
                isAddressVerified: true,
                isBiometricVerified: true,
                isIncomeVerified: true,
                tier: true,
                businessRecordCompleted: true,
                businessDocumentsUploaded: true,
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
                flaggedRecord: {
                    select: {
                        id: true,
                        flagged: true,
                        reason: true,
                        createdAt: true,
                        updatedAt: true,
                    },
                },
            },
        });

        // Calculate tier info
        const tierInfo = this.tierService.getTierInfo(profile);

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
                recoveryEmail: profile.recoveryEmail || null, 
                assetWallet: defaultWallet,
                // Tier info
                tier: tierInfo.tier,
                withdrawalLimit: tierInfo.withdrawalLimit,
                canTransact: tierInfo.canTransact,
            },
        };
    }

    /**
     * Get the user's daily withdrawal usage for the frontend
     * Returns the amount used today and the daily limit based on tier
     */
    async getWithdrawalUsage(user: User) {
        const tierInfo = this.tierService.getTierInfo(user);
        
        // Calculate daily total from the last 24 hours
        const now = new Date();
        const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

        const orders = await this.prisma.order.findMany({
            where: {
                userId: user.id,
                createdAt: { gte: oneDayAgo },
                status: { in: [OrderStatus.filled, OrderStatus.completed, OrderStatus.done] },
            },
            select: { amount: true, currency: true, rateAtConversion: true },
        });

        // Calculate totals in USD
        let usedToday = 0;
        for (const order of orders) {
            if (order.amount) {
                let usdAmount = 0;
                if (order.rateAtConversion) {
                    usdAmount = order.amount * order.rateAtConversion;
                } else if (order.currency) {
                    const rate = await this.coinGeckoCacheService.getPriceInUSD(
                        order.currency.toLowerCase() as SupportedAssets
                    );
                    usdAmount = order.amount * (rate || 0);
                }
                usedToday += usdAmount;
            }
        }

        const dailyLimit = tierInfo.withdrawalLimit === "unlimited" ? -1 : tierInfo.withdrawalLimit;
        const remainingToday = dailyLimit === -1 ? -1 : Math.max(0, dailyLimit - usedToday);
        const percentUsed = dailyLimit === -1 ? 0 : Math.min(100, (usedToday / dailyLimit) * 100);

        return {
            message: "Withdrawal usage retrieved",
            data: {
                usedToday: Math.round(usedToday * 100) / 100,
                dailyLimit,
                remainingToday: remainingToday === -1 ? -1 : Math.round(remainingToday * 100) / 100,
                percentUsed: Math.round(percentUsed * 100) / 100,
                tier: tierInfo.tier,
                canTransact: tierInfo.canTransact,
            },
        };
    }

    async getUserList(query: GetUserListDto) {
        const { pageNumber, pageSize, sortBy, status, accountType, startDate, endDate, searchText, paginated } = query;

        const resolvedPageNumber = !pageNumber || pageNumber <= 1 ? defaultPagination.pageNumber : pageNumber;
        const resolvedPageSize = !pageSize || pageSize <= 0 ? defaultPagination.pageSize : pageSize;

        const dbQuery: Prisma.UserFindManyArgs = {
            where: {
                isDeleted: false,
                ...(status && { status }),
                ...(accountType && { userType: accountType }),
                ...(startDate && endDate && {
                    createdAt: {
                        gte: new Date(startDate),
                        lte: new Date(endDate),
                    },
                }),
                ...(searchText && {
                    OR: [
                        { firstName: { contains: searchText, mode: "insensitive" } },
                        { lastName: { contains: searchText, mode: "insensitive" } },
                        { email: { contains: searchText, mode: "insensitive" } },
                        { phone: { contains: searchText, mode: "insensitive" } },
                    ],
                }),
            },
            select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                recoveryEmail: true,
                phone: true,
                photo: true,
                status: true,
                userType: true,
                createdAt: true,
            },
            orderBy: { createdAt: sortBy },
        };

        const [users, count] = await this.prisma.$transaction([
            this.prisma.user.findMany({
                ...dbQuery,
                ...(paginated === "true" && {
                    skip: (resolvedPageNumber - 1) * resolvedPageSize,
                    take: resolvedPageSize,
                }),
            }),
            this.prisma.user.count({ where: dbQuery.where }),
        ]);

        return {
            success: true,
            message: "Users list retrieved",
            data: {
                meta: buildPaginationMeta(resolvedPageNumber, resolvedPageSize, count, users.length),
                records: users.map(user => ({
                    id: user.id,
                    firstName: user.firstName,
                    lastName: user.lastName,
                    email: user.email,
                    phone: user.phone,
                    photo: user.photo,
                    status: user.status,
                    userType: user.userType,
                    createdAt: user.createdAt,
                })),
            },
        };
    }

    async updateUserDetails(
        options: UpdateUserDetailsDto,
        user: User,
        photo?: Express.Multer.File
    ) {
        if (!photo) {
            throw new AuthGenericException(
                "Profile photo is required to update user details",
                HttpStatus.BAD_REQUEST
            );
        }

        const profileUpdateOptions: Prisma.UserUncheckedUpdateInput = {};

        try {
            const uploadResponse = await this.uploadProfileImage(photo);
            if (user?.photoFileId) {
                try {
                    await this.uploadService.removeImage({
                        fileId: user.photoFileId,
                        key: process.env.IMAGEKIT_PRIVATE_KEY,
                    });
                } catch (error) {
                    Logger.error(`Failed to delete image ${user.photoFileId}:`, error);
                }
            }
            profileUpdateOptions.photo = uploadResponse.url;
            profileUpdateOptions.photoFileId = uploadResponse.fileId;
        } catch (error) {
            Logger.error(`Failed to upload profile image for user ${user.id}:`, error);
            throw new AuthGenericException(
                "Failed to update profile image",
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }

        const updatedUser = await this.prisma.user.update({
            where: { id: user.id },
            data: profileUpdateOptions,
            select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                recoveryEmail: true,
                photo: true,
                phone: true,
                gender: true,
                dateOfBirth: true,
                country: true,
            },
        });

        return {
            message: "Profile photo updated successfully",
            data: {
                ...updatedUser,
                recoveryEmail: updatedUser.recoveryEmail || null,
            },
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
            body: file.buffer,
            quality: 100,
            width: 320,
            type: "image",
        });
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

    async getUserWallets(userId: number, query: GetUserAssetsDto) {
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
                userId: userId,
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
                        percentChange: this.calculatePercentageChange(ticker),
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

    calculatePercentageChange(ticker: Ticker): number | null {
        if (!ticker?.open || !ticker?.last) return null;

        const open = parseFloat(ticker.open);
        const last = parseFloat(ticker.last);

        if (isNaN(open) || open === 0 || isNaN(last)) {
            return null;
        }

        const change = ((last - open) / open) * 100;
        return parseFloat(change.toFixed(2));
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