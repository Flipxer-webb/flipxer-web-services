// src/modules/api/user/services/user.service.ts
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
    RecoveryEmailDto,
    UpdateProfilePasswordDto,
    UpdateUserDetailsDto,
} from "../dtos";
import { UserNotFoundException, AuthGenericException } from "../../auth/errors";
import { Prisma, User } from "@prisma/client";
import { IncorrectPasswordException } from "../errors";
import { QuidaxCacheService } from "@/modules/core/redisCache/services/quidax-cache.service";

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
        dto: UpdateUserDetailsDto,
        user: User,
        photo?: Express.Multer.File
    ) {
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
                        throw new Error(
                            "ImageKit private key is not configured"
                        );
                    }
                    try {
                        await this.uploadService.removeImage({
                            fileId: currentUser.photoFileId,
                            key: process.env.IMAGEKIT_PRIVATE_KEY,
                        });
                    } catch (error) {
                        console.error(
                            `Failed to delete image ${currentUser.photoFileId}:`,
                            error
                        );
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
                dateOfBirth: dto.dateOfBirth
                    ? new Date(dto.dateOfBirth)
                    : undefined,
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

    async recoveryEmail(dto: RecoveryEmailDto) {
        const user = await this.prisma.user.findUnique({
            where: { email: dto.email },
        });

        if (!user) {
            throw new UserNotFoundException(
                "User not found",
                HttpStatus.NOT_FOUND
            );
        }

        await this.prisma.user.update({
            where: { email: dto.email },
            data: {
                recoveryEmail: dto.recoveryEmail,
            },
        });

        return {
            message: "Recovery email updated successfully",
        };
    }

    async updateProfilePassword(options: UpdateProfilePasswordDto, user: User) {
        const userData = await this.prisma.user.findUnique({
            where: { id: user.id },
        });

        if (!userData) {
            throw new UserNotFoundException(
                "User profile could not be found",
                HttpStatus.NOT_FOUND
            );
        }

        const isMatched = await this.authService.comparePassword(
            options.oldPassword,
            userData.password
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
}
