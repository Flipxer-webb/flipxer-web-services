import { storageDirConfig, emailTemplateConfig, COMPANY_NAME, mailConfig } from "@/config";
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
import { UserNotFoundException, AuthGenericException, InvalidVerificationCodeException, VerificationCodeExpiredException, DuplicateVerificationException } from "../../auth/errors";
import { QuidaxCacheService } from "@/modules/core/redisCache/services/quidax-cache.service";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { OrderStatus, Prisma, User, UserType, DocumentVerificationStatus } from "@prisma/client";
import { IncorrectPasswordException } from "../errors";
import { customAlphabet } from "nanoid";
import { Ticker } from "@/libs/quidax/types/trade";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { LiveCoinWatchService } from "@/modules/factory/trading/providers/livecoinwatch/services";
import { LedgerService } from "@/modules/api/trade/services/ledger/ledger.service";
import { RateService } from "@/modules/api/trade/services/rate.service";

@Injectable()
export class UserService {
    private readonly uploadService: ImagekitService | CloudinaryService;
    private readonly logger = new Logger(UserService.name);

    // Profile cache configuration
    private readonly PROFILE_CACHE_TTL = 300; // 5 minutes
    private readonly getProfileCacheKey = (userId: number) => `user:profile:${userId}`;

    constructor(
        private readonly prisma: PrismaService,
        @Inject(forwardRef(() => AuthService))
        private readonly authService: AuthService,
        private readonly emailService: EmailService,
        private readonly uploadFactory: UploadFactory,
        private readonly quidaxCacheService: QuidaxCacheService,
        private readonly tierService: TierService,
        @Inject(TradingInjectionToken.LIVECOINWATCH)
        private readonly liveCoinWatchService: LiveCoinWatchService,
        private readonly redisCacheService: RedisCacheService,
        private readonly ledgerService: LedgerService,
        private readonly rateService: RateService
    ) {
        this.uploadService = this.uploadFactory.build({
            provider: "imagekit",
        });
    }

    async getProfile(user: User) {
        const startTime = Date.now();

        // Try to get from cache first
        const cacheKey = this.getProfileCacheKey(user.id);
        const cachedProfile = await this.redisCacheService.get<any>(cacheKey);

        if (cachedProfile) {
            this.logger.debug(`[PERF] Profile cache HIT for user ${user.id} in ${Date.now() - startTime}ms`);
            return cachedProfile;
        }

        this.logger.debug(`[PERF] Profile cache MISS for user ${user.id}`);
        const dbStartTime = Date.now();

        // OPTIMIZATION: Run both queries in parallel instead of sequential
        const [profile, defaultWallet] = await Promise.all([
            this.prisma.user.findUnique({
                where: { id: user.id },
                select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                    businessName: true,
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
                    isNinVerified: true,
                    isDocumentVerified: true,
                    isAddressVerified: true,
                    isIncomeVerified: true,
                    documentVerificationStatus: true,
                    addressVerificationStatus: true,
                    incomeVerificationStatus: true,
                    tier: true,
                    businessRecordCompleted: true,
                    businessDocumentsUploaded: true,
                    businessDocumentVerificationStatus: true,
                    businessRecord: {
                        select: {
                            id: true,
                            userId: true,
                            businessName: true,
                            natureOfBusiness: true,
                            taxIdentificationNumber: true,
                            expectedTransactionVolume: true,
                            expectedTransactionFrequency: true,
                        },
                    },
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
            }),
            this.prisma.assetWallet.findFirst({
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
            }),
        ]);

        this.logger.log(`[PERF] Profile DB queries (parallel) for user ${user.id}: ${Date.now() - dbStartTime}ms`);

        // Use DB-stored tier as single source of truth
        const userTier = (profile as any).tier ?? 0;

        const response = {
            message: "Profile successfully retrieved",
            data: {
                ...profile,
                recoveryEmail: profile.recoveryEmail || null,
                assetWallet: defaultWallet,
                // Tier info — sourced from DB column, kept in sync by syncTierAndCache
                tier: userTier,
                withdrawalLimit: this.tierService.getWithdrawalLimit(userTier),
                canTransact: userTier > 0,
                // Verification requirements to guide frontend
                verificationRequirements: this.getVerificationRequirements(profile),
            },
        };

        // Cache the response
        await this.redisCacheService.set(cacheKey, response, this.PROFILE_CACHE_TTL);

        this.logger.log(`[PERF] TOTAL getProfile for user ${user.id}: ${Date.now() - startTime}ms`);
        return response;
    }

    /**
     * Calculate what verification steps the user needs to take next.
     * Crucial for Business accounts to avoid being asked for BVN/NIN.
     */
    private getVerificationRequirements(profile: any) {
        if (profile.userType === UserType.BUSINESS) {
            return this.getBusinessVerificationRequirements(profile);
        }
        return this.getIndividualVerificationRequirements(profile);
    }

    private getBusinessVerificationRequirements(profile: any) {
        const requirements = { nextStep: "COMPLETE", details: null as string | null };
        if (!profile.businessRecordCompleted) {
            requirements.nextStep = "BUSINESS_RECORD";
        } else if (!profile.businessDocumentsUploaded) {
            requirements.nextStep = "BUSINESS_DOCUMENT_UPLOAD";
        } else if (profile.businessDocumentVerificationStatus === DocumentVerificationStatus.PENDING) {
            requirements.nextStep = "WAIT_FOR_VERIFICATION";
        } else if (profile.businessDocumentVerificationStatus === DocumentVerificationStatus.DECLINED) {
            requirements.nextStep = "BUSINESS_DOCUMENT_UPLOAD";
            requirements.details = "Previous documents were declined";
        } else if (profile.businessDocumentVerificationStatus !== DocumentVerificationStatus.VERIFIED && !profile.isDocumentVerified) {
            requirements.nextStep = "WAIT_FOR_VERIFICATION";
        }
        return requirements;
    }

    private getIndividualVerificationRequirements(profile: any) {
        const requirements = { nextStep: "COMPLETE", details: null as string | null };
        if (!profile.isEmailVerified) {
            requirements.nextStep = "EMAIL_VERIFICATION";
        } else if (!profile.isBvnVerified && !profile.isNinVerified) {
            requirements.nextStep = "GOVERNMENT_ID";
        } else if (!profile.isDocumentVerified) {
            requirements.nextStep = "IDENTITY_DOCUMENT";
            if (profile.documentVerificationStatus === DocumentVerificationStatus.DECLINED) {
                requirements.details = "Document verification was declined";
            }
        } else if (!profile.isAddressVerified) {
            requirements.nextStep = "ADDRESS_VERIFICATION";
            if (profile.addressVerificationStatus === DocumentVerificationStatus.DECLINED) {
                requirements.details = "Address verification was declined";
            }
        } else if (!profile.isIncomeVerified) {
            requirements.nextStep = "INCOME_VERIFICATION";
            if (profile.incomeVerificationStatus === DocumentVerificationStatus.DECLINED) {
                requirements.details = "Income verification was declined";
            }
        }
        return requirements;
    }

    /**
     * Get the user's daily usage per operation type for the frontend.
     * Returns per-operation (buy/sell/swap/send) used today and daily limits.
     */
    async getWithdrawalUsage(user: User) {
        // Use DB-stored tier as single source of truth
        const userTier = (user as any).tier ?? 0;
        const dailyLimits = this.tierService.getDailyLimits(userTier, user.userType);

        // Calculate daily totals from start of today (calendar-day, UTC)
        const now = new Date();
        const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

        const orders = await this.prisma.order.findMany({
            where: {
                userId: user.id,
                createdAt: { gte: startOfToday },
                status: { in: [OrderStatus.filled, OrderStatus.completed, OrderStatus.done] },
            },
            select: { amount: true, currency: true, orderCategory: true },
        });

        // Build per-operation USD totals
        const usageByOp: Record<string, number> = { buy: 0, sell: 0, swap: 0, send: 0 };
        for (const order of orders) {
            if (order.amount && order.currency) {
                let rate = 0;
                try {
                    rate = await this.liveCoinWatchService.getPriceInUSD(
                        order.currency.toLowerCase()
                    );
                } catch (error) {
                    this.logger.warn(`Failed to fetch USD rate for ${order.currency}: ${error.message}`);
                }
                const usdAmount = order.amount * (rate || 0);

                const cat = order.orderCategory;
                if (cat === "BUY") usageByOp.buy += usdAmount;
                else if (cat === "SELL") usageByOp.sell += usdAmount;
                else if (cat === "SWAP") usageByOp.swap += usdAmount;
                else if (cat === "SEND") usageByOp.send += usdAmount;
            }
        }

        const round = (v: number) => Math.round(v * 100) / 100;

        const buildOpData = (op: "buy" | "sell" | "swap" | "send") => {
            const limit = dailyLimits[op];
            const used = usageByOp[op];
            const isUnlimited = limit === "unlimited";
            const numericLimit = isUnlimited ? -1 : (limit as number);
            const remaining = isUnlimited ? -1 : Math.max(0, numericLimit - used);
            const percentUsed = isUnlimited ? 0 : Math.min(100, (used / numericLimit) * 100);
            return {
                usedToday: round(used),
                dailyLimit: numericLimit,
                remainingToday: remaining === -1 ? -1 : round(remaining),
                percentUsed: round(percentUsed),
            };
        };

        return {
            message: "Withdrawal usage retrieved",
            data: {
                buy: buildOpData("buy"),
                sell: buildOpData("sell"),
                swap: buildOpData("swap"),
                send: buildOpData("send"),
                tier: userTier,
                canTransact: userTier > 0,
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

        const profileUpdateOptions: Prisma.UserUncheckedUpdateInput = {
            ...options,
            dateOfBirth: options.dateOfBirth
                ? new Date(options.dateOfBirth)
                : undefined,
        };

        if (photo) {
            try {
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
            } catch (error) {
                Logger.error(
                    `Failed to upload profile image for user ${user.id}:`,
                    error
                );
                throw new AuthGenericException(
                    "Failed to update profile image",
                    HttpStatus.INTERNAL_SERVER_ERROR
                );
            }
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

        // Invalidate profile cache after update
        await this.redisCacheService.del(this.getProfileCacheKey(user.id));

        return {
            message: "Profile details updated successfully",
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
        // Fetch ledger balances and all rates in parallel
        // Use RateService instead of QuidaxCacheService for consistency with getUserWallets
        const [ledgerBalances, allRates] = await Promise.all([
            this.ledgerService.getAllBalances(user.id),
            this.rateService.getAllRates(),
        ]);

        // Create map for rates (AssetRate has sellRate/buyRate)
        const rateMap = new Map(
            allRates.map(r => [r.currency.toUpperCase(), r])
        );

        let totalBalance = 0;

        for (const [currency, balanceInfo] of ledgerBalances) {
            const assetCurrencyUpper = currency.toUpperCase();
            const balance = Number(balanceInfo.available);

            // Get rate from RateService map
            const rateData = rateMap.get(assetCurrencyUpper);
            let usedRate = 0;

            if (rateData) {
                // Use sellRate (Ask price) for valuation, consistent with getUserWallets logic
                // This represents the price required to BUY the asset back from the user
                usedRate = rateData.sellRate;
            }

            if (usedRate > 0 && !Number.isNaN(balance)) {
                totalBalance += balance * usedRate;
            }
        }

        return {
            message: "Aggregated wallet balance retrieved",
            data: {
                total: totalBalance, // Return number, frontend handles formatting
                referenceCurrency: "ngn",
            },
        };
    }

    async getUserWallets(userId: number, query: GetUserAssetsDto) {
        const startTime = Date.now();
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

        // OPTIMIZATION: Run all queries in parallel instead of sequential
        const dbStartTime = Date.now();
        const [assetsResult, dynamicRates, liveMarketData, ledgerBalances] = await Promise.all([
            // Query 1: Fetch user assets + count in a transaction
            this.prisma.$transaction([
                this.prisma.assetWallet.findMany({
                    ...dbQuery,
                    ...(query.paginated === "true" && {
                        skip: (resolvedPageNumber - 1) * resolvedPageSize,
                        take: resolvedPageSize,
                    }),
                }),
                this.prisma.assetWallet.count({ where: dbQuery.where }),
            ]),
            // Query 2: Fetch dynamic rates from RateService (uses LiveCoinWatch)
            this.rateService.getAllRates(),
            // Query 3: Fetch live Quidax rates (from cache or API)
            this.quidaxCacheService.getMarketTickers(),
            // Query 4: Fetch ledger balances (virtual balance system)
            this.ledgerService.getAllBalances(userId),
        ]);

        this.logger.log(`[PERF] getUserWallets DB+API queries (parallel) for user ${userId}: ${Date.now() - dbStartTime}ms`);

        const [assets, count] = assetsResult;

        // Fetch LiveCoinWatch market data for percentage change fallback
        const uniqueAssets = [...new Set(assets.map(a => a.assetCurrency))];
        const lcwStartTime = Date.now();
        const lcwData = await this.liveCoinWatchService.getBatchMarketData(uniqueAssets);
        this.logger.log(`[PERF] LiveCoinWatch batch fetch for ${uniqueAssets.length} assets: ${Date.now() - lcwStartTime}ms`);

        // Create a map of dynamic rates by currency
        const dynamicRatesMap = new Map(
            dynamicRates.map((rate) => [rate.currency.toLowerCase(), rate])
        );
        const referenceCurrency = "ngn"; // Change to 'usdt' or dynamic as needed

        // Merge data into asset response
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
                const assetCurrencyUpper = asset.assetCurrency.toUpperCase();

                // Get ledger balance (virtual balance system)
                const ledgerBalance = ledgerBalances.get(assetCurrencyUpper);
                // Use ledger balance if available, otherwise fall back to 0 (swept to main wallet)
                const balance = ledgerBalance
                    ? Number(ledgerBalance.available)
                    : 0;
                const heldBalance = ledgerBalance
                    ? Number(ledgerBalance.held)
                    : 0;

                // Dynamic rate lookup (from RateService - uses LiveCoinWatch)
                const dynamicRate = dynamicRatesMap.get(assetCurrency);
                const buyRate = dynamicRate?.buyRate ?? 0;
                const sellRate = dynamicRate?.sellRate ?? 0;

                // Live market data lookup
                const marketSymbol = `${assetCurrency}${referenceCurrency}`;
                const ticker = liveMarketData?.[marketSymbol]?.ticker;

                // LiveCoinWatch data lookup
                const marketData = lcwData[assetCurrency];

                // Prioritize LiveCoinWatch for market stats (24h change) as it's more reliable/global
                // Fallback to Quidax generic calculation if LCW is unavailable
                const percentChange = marketData?.change24h ?? this.calculatePercentageChange(ticker);

                // Calculate Live Converted Balance using dynamic rate
                let liveConvertedBalance: any = "0";

                // Use dynamic rate for conversion (consistent with buy/sell operations)
                if (sellRate > 0) {
                    liveConvertedBalance = (balance * sellRate).toFixed(2);
                } else if (ticker?.sell) {
                    // Fallback to Quidax ticker if dynamic rate unavailable
                    const rate = Number.parseFloat(ticker.sell);
                    if (!Number.isNaN(rate) && !Number.isNaN(balance)) {
                        liveConvertedBalance = (balance * rate).toFixed(2);
                    }
                }

                return {
                    ...asset,
                    balance: balance.toString(), // Override with ledger balance
                    locked: heldBalance.toString(), // Use ledger held amount
                    convertedBalance: liveConvertedBalance, // Override DB value with live value
                    buyRate: {
                        value: buyRate.toFixed(4),
                        referenceCurrency,
                    },
                    sellRate: {
                        value: sellRate.toFixed(4),
                        referenceCurrency,
                    },
                    liveRate: {
                        buy: ticker?.buy ?? null,
                        sell: ticker?.sell ?? null,
                        last: ticker?.last ?? null,
                        percentChange: percentChange,
                        referenceCurrency,
                    },
                };
            }),
        };

        this.logger.log(`[PERF] TOTAL getUserWallets for user ${userId}: ${Date.now() - startTime}ms`);
        return {
            message: "Assets successfully retrieved",
            data: responseData,
        };
    }

    calculatePercentageChange(ticker: Ticker): number | null {
        if (!ticker?.open || !ticker?.last) return null;

        const open = Number.parseFloat(ticker.open);
        const last = Number.parseFloat(ticker.last);

        if (Number.isNaN(open) || open === 0 || Number.isNaN(last)) {
            return null;
        }

        const change = ((last - open) / open) * 100;
        return Number.parseFloat(change.toFixed(2));
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

        // Check that new password is different from old password
        if (options.newPassword === options.oldPassword) {
            throw new IncorrectPasswordException(
                "Your new password must be different from your current password",
                HttpStatus.BAD_REQUEST
            );
        }

        const newHashedPassword = await this.authService.hashPassword(
            options.newPassword
        );

        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                password: newHashedPassword,
                passwordChangedAt: new Date(),
            },
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

        // Normalize email
        const email = dto.email.toLowerCase().trim();

        // Upsert the recovery email verification request
        await this.prisma.recoveryEmailVerificationRequest.upsert({
            where: {
                userId: user.id,
            },
            update: {
                email: email,
                code: verificationCode,
            },
            create: {
                userId: user.id,
                email: email,
                code: verificationCode,
            },
        });

        // Prepare email data
        const name =
            `${user.firstName || ""} ${user.lastName || ""}`.trim() || "User";
        const team = COMPANY_NAME;

        try {
            await this.emailService.sendMailWithTemplate({
                from: { address: mailConfig.senderMail },
                to: [{ email_address: { address: user.email } }],
                template_key: emailTemplateConfig.recovery_pin,
                merge_info: {
                    name,
                    otp: verificationCode,
                    expiry_minutes: "30",
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

    /**
     * Update user's notification token for push notifications (FCM)
     * Now stores in DeviceToken table for multi-device support.
     */
    async updateNotificationToken(
        user: User,
        token: string | null,
        deviceName?: string,
        platform?: string
    ): Promise<{ message: string }> {
        if (token) {
            // Upsert into DeviceToken table (best-effort).
            // If this fails (e.g. migration drift), we still keep legacy token flow working.
            try {
                await this.prisma.deviceToken.upsert({
                    where: {
                        userId_token: { userId: user.id, token },
                    },
                    update: {
                        deviceName: deviceName ?? undefined,
                        platform: platform ?? undefined,
                    },
                    create: {
                        userId: user.id,
                        token,
                        deviceName: deviceName ?? null,
                        platform: platform ?? "web",
                    },
                });
            } catch (error) {
                this.logger.warn(
                    `DeviceToken upsert failed for user ${user.id}, falling back to legacy notificationToken: ${error?.message || error}`
                );
            }

            // Also keep legacy field in sync for backward compatibility
            await this.prisma.user.update({
                where: { id: user.id },
                data: { notificationToken: token },
            });
        } else {
            // Disable: remove all device tokens for this user (best-effort)
            try {
                await this.prisma.deviceToken.deleteMany({
                    where: { userId: user.id },
                });
            } catch (error) {
                this.logger.warn(
                    `DeviceToken cleanup failed for user ${user.id}, continuing with legacy notificationToken cleanup: ${error?.message || error}`
                );
            }

            await this.prisma.user.update({
                where: { id: user.id },
                data: { notificationToken: null },
            });
        }

        // Invalidate profile cache
        await this.redisCacheService.del(this.getProfileCacheKey(user.id));

        return {
            message: token
                ? "Push notifications enabled"
                : "Push notifications disabled",
        };
    }

    async getUserByEmail(email: string) {
        const normalizedEmail = email.toLowerCase().trim();
        const user = await this.prisma.user.findUnique({
            where: { email: normalizedEmail },
            select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                photo: true,
                status: true,
            },
        });

        if (!user) {
            throw new UserNotFoundException("User not found", HttpStatus.NOT_FOUND);
        }

        return {
            message: "User found",
            data: user,
        };
    }
}