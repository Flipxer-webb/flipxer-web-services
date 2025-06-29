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
import { AssetWallet, Prisma, User } from "@prisma/client";
import { IncorrectPasswordException } from "../errors";

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
