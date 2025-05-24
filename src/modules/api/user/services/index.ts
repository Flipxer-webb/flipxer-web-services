import { storageDirConfig, mailConfig, emailTemplateConfig } from "@/config";
import { EmailService } from "@/modules/core/email/services";
import { PrismaService } from "@/modules/core/prisma/services";
import {
    buildPaginationMeta,
    defaultPagination,
    generateRandomNum,
} from "@/utils";
import { ApiResponse, buildResponse } from "@/utils/api-response-util";
import { Injectable, forwardRef, Inject } from "@nestjs/common";
import { AuthService } from "../../auth/services";
import { UploadFactory } from "@/modules/core/upload/services";
import { CloudinaryService } from "@/modules/core/upload/services/cloudinary";
import { UploadApiResponse } from "cloudinary";
import { ImagekitService } from "@/modules/core/upload/services/imagekit";
import { UploadResponse } from "imagekit/dist/libs/interfaces";
import {
    GetUserAssetsDto,
    SendRecoveryPinDto,
    VerifyRecoveryPinDto,
} from "../dtos";
import { Logger } from "moment-logger";
import {
    UserNotFoundException,
    InvalidVerificationCodeException,
    VerificationCodeExpiredException,
    AuthGenericException,
} from "../../auth/errors";
import { COMPANY_NAME } from "@/config";
import { AssetWallet, Prisma, User } from "@prisma/client";

const logger = new Logger();

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

    async getProfile(user: User): Promise<ApiResponse> {
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

        return buildResponse({
            message: "Profile successfully retrieved",
            data: {
                ...profile,
                assetWallet: defaultWallet,
            },
        });
    }

    async getUserAggregatedWalletBalance(user: User) {
        const result = await this.prisma.assetWallet.aggregate({
            where: { userId: user.id },
            _sum: {
                convertedBalance: true,
            },
        });

        return buildResponse({
            message: "Aggregated wallet balance retrieved",
            data: {
                total: result._sum.convertedBalance ?? 0,
                referenceCurrency: "ngn",
            },
        });
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
                        { assetName: { contains: query.searchText } },
                        { assetCurrency: { contains: query.searchText } },
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

        //buy and sell rate to come from admin settings
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

        return buildResponse({
            message: "Assets successfully retrieved",
            data: responseData,
        });
    }

    private async uploadProfileImage(
        file: string
    ): Promise<UploadApiResponse | UploadResponse> {
        const date = Date.now();
        const body = Buffer.from(file, "base64");

        return await this.uploadService.uploadCompressedImage({
            dir: storageDirConfig.profile,
            name: `profile-image-${date}-${generateRandomNum(5)}`,
            format: "webp",
            body: body,
            quality: 100,
            width: 320,
            type: "image",
        });
    }

    // Send recovery PIN email using sendMailWithTemplate
    async sendRecoveryPinEmail(
        userId: number,
        email: string,
        name: string,
        pin: string
    ) {
        try {
            // Prepare email data for the template
            const mergeInfo = {
                name,
                code: pin, // Assuming the template uses 'code' for the PIN
                team: COMPANY_NAME,
                notice: "This PIN expires in 1 hour.",
            };

            // Send email using the template-based approach from AuthService
            await this.emailService.sendMailWithTemplate({
                from: { address: mailConfig.senderMail },
                to: [{ email_address: { address: email } }],
                template_key: emailTemplateConfig.recovery_pin, // Define this in your emailTemplateConfig
                merge_info: mergeInfo,
            });

            logger.info(`Recovery PIN email sent successfully to ${email}`);
        } catch (error) {
            logger.error(`Error sending recovery PIN email: ${error.message}`, {
                userId,
                email,
            });
            logger.error(`Full error details: ${JSON.stringify(error)}`);
            throw new AuthGenericException(
                "Failed to send recovery PIN email. Please try again later."
            );
        }
    }

    // Generate and send 6-digit PIN
    async sendRecoveryPin(dto: SendRecoveryPinDto): Promise<ApiResponse> {
        try {
            const user = await this.prisma.user.findUnique({
                where: { email: dto.email },
                include: { recoveryEmail: true },
            });

            if (!user) {
                logger.warn(`User not found for email: ${dto.email}`);
                throw new UserNotFoundException();
            }

            const pin = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit PIN

            // Update or create recovery email record
            await this.prisma.recoveryEmail.upsert({
                where: { userId: user.id },
                update: {
                    recoveryPin: pin,
                    lastPinGeneratedAt: new Date(),
                },
                create: {
                    userId: user.id,
                    recoveryPin: pin,
                    lastPinGeneratedAt: new Date(),
                },
            });

            // Send recovery PIN email to dto.email (primary email)
            await this.sendRecoveryPinEmail(
                user.id,
                dto.email,
                `${user.firstName || ""} ${user.lastName || ""}`.trim() ||
                    "User",
                pin
            );

            logger.info(`Recovery PIN request created for user: ${user.email}`);
            return buildResponse({ message: "Recovery PIN sent successfully" });
        } catch (error) {
            if (
                error instanceof UserNotFoundException ||
                error instanceof AuthGenericException
            ) {
                throw error;
            }
            logger.error(
                `Error in sendRecoveryPin for email ${dto.email}: ${error.message}`,
                { stack: error.stack }
            );
            throw new AuthGenericException(
                "An error occurred while sending the recovery PIN"
            );
        }
    }

    // Verify PIN and update recovery email
    async verifyRecoveryPin(dto: VerifyRecoveryPinDto): Promise<ApiResponse> {
        try {
            const user = await this.prisma.user.findUnique({
                where: { email: dto.email },
                include: { recoveryEmail: true },
            });

            if (!user) {
                throw new UserNotFoundException(
                    "User not found"
                );
            }

            const recoveryEmail = user.recoveryEmail;

            if (recoveryEmail.recoveryPin !== dto.pin) {
                throw new InvalidVerificationCodeException("Invalid PIN");
            }

            const currentTime = new Date();
            const pinGeneratedAt = recoveryEmail.lastPinGeneratedAt;
            if (
                !pinGeneratedAt ||
                currentTime.getTime() - pinGeneratedAt.getTime() > 3600000
            ) {
                logger.warn(`PIN has expired for user ID: ${user.id}`);
                throw new VerificationCodeExpiredException("PIN has expired");
            }

            // Update recovery email with dto.recoveryEmail upon verification
            await this.prisma.recoveryEmail.update({
                where: { userId: user.id },
                data: {
                    recoveryEmail: dto.recoveryEmail,
                    recoveryPin: null,
                    lastPinGeneratedAt: new Date(),
                },
            });
            logger.info(
                `Recovery email updated successfully for user ID: ${user.id}`
            );

            return buildResponse({
                message: "Recovery email updated successfully",
            });
        } catch (error) {
            if (
                error instanceof UserNotFoundException ||
                error instanceof InvalidVerificationCodeException ||
                error instanceof VerificationCodeExpiredException
            ) {
                throw error;
            }
            logger.error(
                `Error in verifyRecoveryPin for email ${dto.email}: ${error.message}`,
                { stack: error.stack }
            );
            throw new AuthGenericException(
                "An error occurred while verifying the recovery PIN"
            );
        }
    }
}
