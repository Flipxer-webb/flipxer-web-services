import {
    Injectable,
    ForbiddenException,
    NotFoundException,
    BadRequestException,
    Inject,
    HttpStatus,
    Logger,
} from "@nestjs/common";
import { PrismaService } from "../../../core/prisma/services";
import {
    CreateBankDetailDto,
    UpdateBankDetailDto,
    BankDetailResponseDto,
    VerifyBankAccountDto,
} from "../dtos";
import { ApiResponse, buildResponse, generateId } from "@/utils";
import { BankInjectionToken } from "@/modules/factory/bank/types";
import { FincraBank } from "@/modules/factory/bank/providers/fincra.provider";
import { NombaBank } from "@/modules/factory/bank/providers/nomba.provider";
import { BankCacheService } from "@/modules/core/redisCache/services/bank-cache.service";
import {
    DuplicateTransactionException,
    TransactionRefNotFoundException,
} from "../../transactions/errors";
import { TransactionNotFoundException } from "../../trade";
import {
    NotificationBeneficiary,
    NotificationStatus,
    NotificationType,
    OrderCategory,
    OrderStatus,
    OrderStreamlinedStatus,
    TransactionStatus,
    UserNotificationTarget,
} from "@prisma/client";
import logger from "moment-logger";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import { UserNotFoundException } from "../../auth";
import { BankDetailNotFoundException } from "../errors";
import { TransferFailedHandlerOptions } from "../interfaces";
import { NotificationMessageService } from "@/modules/core/messages/services/notification.service";
import { WsGateway } from "../../trade/gateway/v1";
import { NotificationEvent } from "../../notification/events/notification.event";

@Injectable()
export class BankService {
    private readonly logger = new Logger('BankService');

    constructor(
        private readonly prisma: PrismaService,
        @Inject(BankInjectionToken.FINCRA)
        private readonly fincraService: FincraBank,
        @Inject(BankInjectionToken.NOMBA)
        private readonly nombaService: NombaBank,
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService,
        private readonly notificationMessage: NotificationMessageService,
        private readonly wsGateway: WsGateway,
        private readonly notificationEvent: NotificationEvent,
        private readonly bankCacheService: BankCacheService
    ) { }

    async getListOfBanks() {
        const banks = await this.nombaService.getBanks();
        return buildResponse({
            message: "banks successfully retrieved",
            data: banks,
        });
    }

    /**
     * Initialize payment using Nomba Checkout
     * Returns a checkout link for the user to complete payment
     */
    async initializeNombaCheckout(userId: number, amount: number, callbackUrl?: string) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
        });

        if (!user) {
            throw new UserNotFoundException("User not found");
        }

        const result = await this.nombaService.initializePayment(
            {
                id: user.id,
                email: user.email,
                firstName: user.firstName,
                lastName: user.lastName,
            },
            amount,
            callbackUrl
        );

        return buildResponse({
            message: "Checkout created successfully",
            data: result.data,
        });
    }

    /**
     * Verify Nomba checkout/payment status
     */
    async verifyNombaCheckout(orderReference: string) {
        const result = await this.nombaService.verifyTransaction(orderReference);

        return buildResponse({
            message: "Checkout status retrieved",
            data: result.data,
        });
    }

    async verifyBankAccount(options: VerifyBankAccountDto) {
        // Check cache first to avoid external API call
        const cached = await this.bankCacheService.getCachedVerification(
            options.bankCode,
            options.accountNumber
        );

        if (cached) {
            return buildResponse({
                message: "account successfully verified",
                data: {
                    accountName: cached.accountName,
                    accountNumber: cached.accountNumber,
                    fromCache: true,
                },
            });
        }

        // Cache miss - call Nomba API
        const account = await this.nombaService.resolveBankAccount({
            account_number: options.accountNumber,
            bank_code: options.bankCode,
        });

        if (!account || !account.data) {
            throw new BadRequestException("Failed to verify bank account");
        }

        // Cache the successful verification result
        await this.bankCacheService.cacheVerification(
            options.bankCode,
            options.accountNumber,
            account.data.accountName
        );

        return buildResponse({
            message: "account successfully verified",
            data: {
                accountName: account.data.accountName,
                accountNumber: account.data.accountNumber,
            },
        });
    }

    async create(
        userId: number,
        dto: CreateBankDetailDto
    ): Promise<ApiResponse<BankDetailResponseDto>> {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
        });
        if (
            !user ||
            (user.userType !== "INDIVIDUAL" && user.userType !== "BUSINESS")
        ) {
            throw new ForbiddenException(
                "Only INDIVIDUAL and BUSINESS users can add bank details"
            );
        }

        const data = await this.prisma.bankDetail.create({
            data: {
                userId,
                bankName: dto.bankName,
                accountName: dto.accountName,
                accountNumber: dto.accountNumber,
                bankCode: dto.bankCode,
            },
        });

        return buildResponse({
            message: "Bank detail created",
            data,
        });
    }

    async findAll(
        userId: number
    ): Promise<ApiResponse<BankDetailResponseDto[]>> {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
        });
        if (!user) {
            throw new UserNotFoundException("User not found");
        }

        const data = await this.prisma.bankDetail.findMany({
            where: { userId },
        });

        return buildResponse({
            message: "Bank details retrieved",
            data,
        });
    }

    async findOne(
        userId: number,
        bankDetailId: number
    ): Promise<ApiResponse<BankDetailResponseDto>> {
        const bankDetail = await this.prisma.bankDetail.findUnique({
            where: { id: bankDetailId },
        });

        // SECURITY: Verify the bank detail belongs to the requesting user
        if (!bankDetail || bankDetail.userId !== userId) {
            throw new BankDetailNotFoundException(
                "Bank detail not found or does not belong to this user",
                HttpStatus.NOT_FOUND
            );
        }

        return buildResponse({
            message: "Bank detail retrieved",
            data: bankDetail,
        });
    }

    async update(
        userId: number,
        bankDetailId: number,
        dto: UpdateBankDetailDto
    ): Promise<ApiResponse<BankDetailResponseDto>> {
        const bankDetail = await this.prisma.bankDetail.findUnique({
            where: { id: bankDetailId },
        });

        if (!bankDetail || bankDetail.userId !== userId) {
            throw new BankDetailNotFoundException(
                "Bank detail not found or does not belong to this user",
                HttpStatus.NOT_FOUND
            );
        }

        const data = await this.prisma.bankDetail.update({
            where: { id: bankDetailId },
            data: {
                bankName: dto.bankName ?? bankDetail.bankName,
                accountName: dto.accountName ?? bankDetail.accountName,
                accountNumber: dto.accountNumber ?? bankDetail.accountNumber,
            },
        });

        return buildResponse({
            message: "Bank detail updated",
            data,
        });
    }

    async remove(
        userId: number,
        bankDetailId: number
    ): Promise<ApiResponse<null>> {
        const bankDetail = await this.prisma.bankDetail.findUnique({
            where: { id: bankDetailId },
        });

        if (!bankDetail || bankDetail.userId !== userId) {
            throw new BankDetailNotFoundException(
                "Bank detail not found or does not belong to this user",
                HttpStatus.NOT_FOUND
            );
        }

        await this.prisma.bankDetail.delete({
            where: { id: bankDetailId },
        });

        return buildResponse({
            message: "Bank detail deleted",
            data: null,
        });
    }

    async verifyFincraTransactionHandler(reference: string) {
        const result = await this.fincraService.verifyTransaction(reference);
        return result;
    }
    async validateTransactionRef(ref: string) {
        const transactionRef = await this.prisma.payment.findUnique({
            where: {
                reference: ref,
            },
        });

        if (!transactionRef) {
            throw new TransactionRefNotFoundException(
                "Transaction ref not found",
                HttpStatus.BAD_REQUEST
            );
        }

        return transactionRef;
    }

    async paymentFailedHandler(reference: string) {
        try {
            const transaction = await this.prisma.payment.findUnique({
                where: { reference: reference },
            });
            if (!transaction) {
                throw new TransactionNotFoundException(
                    "Paystack transaction payment reference not found",
                    HttpStatus.NOT_FOUND
                );
            }

            if (transaction.paymentStatus === TransactionStatus.SUCCESS) {
                throw new DuplicateTransactionException(
                    "Duplicate transaction. Transaction already successful",
                    HttpStatus.CONFLICT
                );
            }

            await this.prisma.payment.update({
                where: {
                    reference: transaction.reference,
                },
                data: {
                    status: TransactionStatus.FAILED,
                    paymentStatus: TransactionStatus.FAILED,
                },
            });

            if (transaction.orderId) {
                await this.prisma.order.update({
                    where: { id: transaction.orderId },
                    data: {
                        paymentStatus: TransactionStatus.FAILED,
                        streamlinedStatus: OrderStreamlinedStatus.failed,
                    },
                });
            }
        } catch (error) {
            logger.error(error);
        }
    }

    async paymentAbandonedHandler(reference: string) {
        try {
            const transaction = await this.prisma.payment.findUnique({
                where: { reference: reference },
            });
            if (!transaction) {
                throw new TransactionNotFoundException(
                    "Paystack transaction payment reference not found",
                    HttpStatus.NOT_FOUND
                );
            }

            if (transaction.paymentStatus === TransactionStatus.SUCCESS) {
                throw new DuplicateTransactionException(
                    "Duplicate transaction. Transaction already successful",
                    HttpStatus.CONFLICT
                );
            }

            await this.prisma.payment.update({
                where: {
                    reference: transaction.reference,
                },
                data: {
                    status: TransactionStatus.FAILED,
                    paymentStatus: TransactionStatus.ABANDONED,
                },
            });

            if (transaction.orderId) {
                await this.prisma.order.update({
                    where: { id: transaction.orderId },
                    data: {
                        paymentStatus: TransactionStatus.FAILED,
                        streamlinedStatus: OrderStreamlinedStatus.failed,
                    },
                });
            }
        } catch (error) {
            logger.error(error);
        }
    }

    async paymentSuccessHandler(reference: string) {
        this.logger.log(`Processing payment success for reference: ${reference}`);

        try {
            const transaction = await this.prisma.payment.findUnique({
                where: { reference: reference },
            });
            if (!transaction) {
                this.logger.error(`Payment not found for reference: ${reference}`);
                throw new TransactionNotFoundException(
                    "transaction payment reference not found",
                    HttpStatus.NOT_FOUND
                );
            }

            this.logger.debug(`Found payment: orderId=${transaction.orderId}, status=${transaction.paymentStatus}`);

            if (transaction.paymentStatus === TransactionStatus.SUCCESS) {
                throw new DuplicateTransactionException(
                    "Duplicate transaction. Transaction already successful",
                    HttpStatus.CONFLICT
                );
            }

            const admin = await this.prisma.user.findFirst({
                where: { role: { slug: "super-admin" } },
            });

            if (!admin) {
                throw new UserNotFoundException("Super Admin user not found");
            }

            await this.prisma.payment.update({
                where: {
                    reference: transaction.reference,
                },
                data: {
                    status: TransactionStatus.SUCCESS,
                    paymentStatus: TransactionStatus.SUCCESS,
                },
            });

            if (transaction.orderId) {
                const order = await this.prisma.order.findUnique({
                    where: { id: transaction.orderId },
                    include: { user: { select: { id: true, email: true } } },
                });

                if (order.orderCategory === OrderCategory.BUY) {
                    // BUY ORDER: Payment received, but crypto not yet sent
                    // Keep order in PROCESSING state until Quidax withdrawal succeeds
                    this.logger.log(`BUY order ${order.id}: Payment received, initiating crypto transfer`);

                    const withdrawalReference = generateId({ type: "reference" });

                    // Update order to processing state
                    // NOTE: We don't store withdrawalReference here to avoid unique constraint conflict
                    // The link is maintained via transaction_note on the admin's SELL order
                    await this.prisma.order.update({
                        where: { id: transaction.orderId },
                        data: {
                            paymentStatus: TransactionStatus.SUCCESS,
                            status: OrderStatus.processing, // Still processing - crypto not sent yet
                            streamlinedStatus: OrderStreamlinedStatus.pending, // Not complete until crypto delivered
                        },
                    });


                    // Emit intermediate status update
                    this.wsGateway.notifyTransactionUpdate(order.user.id, {
                        type: "transaction_update",
                        transaction: {
                            id: order.id,
                            transactionId: order.transactionId,
                            status: OrderStatus.processing,
                            streamlinedStatus: OrderStreamlinedStatus.pending,
                            orderCategory: order.orderCategory,
                            amount: order.amount,
                            currency: order.currency,
                            createdAt: order.createdAt,
                            updatedAt: new Date(),
                        },
                    });

                    // Initiate crypto transfer to user's wallet
                    this.logger.log(`Initiating Quidax withdrawal for order ${order.id}: ${order.amount} ${order.currency} to ${order.recipient}`);

                    try {
                        const requestRes = await this.quidaxService.createWithdrawerRequest({
                            amount: order.amount.toString(),
                            currency: order.currency.toLowerCase(),
                            narration: `flipxer buy order ${order.id}`,
                            transaction_note: `BUY:${order.id}`, // Tag for linking back to BUY order
                            user_id: "me", // main account on quidax
                            fund_uid: order.recipient, // receiving wallet address
                            fund_uid2: order.destinationTag, // destination tag
                            reference: withdrawalReference,
                        });

                        this.logger.log(`Quidax withdrawal initiated: quidaxId=${requestRes.data.id}, reference=${withdrawalReference}, orderId=${order.id}`);

                        // Create admin's SELL order for tracking
                        const amtFiat = await this.getAmountInNaira(
                            requestRes.data.currency,
                            Number(requestRes.data.amount)
                        );

                        await this.prisma.order.create({
                            data: {
                                orderCategory: OrderCategory.SELL,
                                status: OrderStatus.processing,
                                orderReference: withdrawalReference,
                                transactionId: generateId({ type: "transaction" }),
                                providerOrderId: requestRes.data.id,
                                userId: admin.id,
                                currency: requestRes.data.currency.toUpperCase(),
                                narration: requestRes.data.narration,
                                transaction_note: `BUY:${order.id}`, // Link to original BUY order
                                recipient: requestRes.data.recipient.details.address,
                                amount: +requestRes.data.amount,
                                fee: +requestRes.data.fee,
                                total: +requestRes.data.total,
                                sourceType: requestRes.data.type,
                                amountInFiat: amtFiat?.amount,
                                rateAtConversion: amtFiat?.rate,
                            },
                        });

                        this.logger.log(`BUY order ${order.id}: Crypto transfer initiated, awaiting Quidax confirmation`);
                        // NOTE: Completion notification will be sent by withdrawal-webhook.handler when Quidax confirms
                    } catch (withdrawError) {
                        // Quidax withdrawal failed - mark order as failed
                        this.logger.error(`BUY order ${order.id}: Quidax withdrawal FAILED: ${withdrawError.message}`, withdrawError.stack);

                        await this.prisma.order.update({
                            where: { id: transaction.orderId },
                            data: {
                                status: OrderStatus.failed,
                                streamlinedStatus: OrderStreamlinedStatus.failed,
                                reason: `Crypto transfer failed: ${withdrawError.message}`,
                            },
                        });

                        // Notify user of failure
                        this.wsGateway.notifyTransactionUpdate(order.user.id, {
                            type: "transaction_update",
                            transaction: {
                                id: order.id,
                                transactionId: order.transactionId,
                                status: OrderStatus.failed,
                                streamlinedStatus: OrderStreamlinedStatus.failed,
                                orderCategory: order.orderCategory,
                                amount: order.amount,
                                currency: order.currency,
                                createdAt: order.createdAt,
                                updatedAt: new Date(),
                            },
                        });

                        throw withdrawError; // Re-throw to trigger Fincra retry
                    }
                } else {
                    // Non-BUY order (shouldn't happen via this flow, but handle gracefully)
                    await this.prisma.order.update({
                        where: { id: transaction.orderId },
                        data: {
                            paymentStatus: TransactionStatus.SUCCESS,
                            status: OrderStatus.confirmed,
                            streamlinedStatus: OrderStreamlinedStatus.completed,
                        },
                    });

                    this.wsGateway.notifyTransactionUpdate(order.user.id, {
                        type: "transaction_update",
                        transaction: {
                            id: order.id,
                            transactionId: order.transactionId,
                            status: OrderStatus.confirmed,
                            streamlinedStatus: OrderStreamlinedStatus.completed,
                            orderCategory: order.orderCategory,
                            amount: order.amount,
                            currency: order.currency,
                            createdAt: order.createdAt,
                            updatedAt: new Date(),
                        },
                    });
                }
            }

        } catch (error) {
            this.logger.error(`paymentSuccessHandler failed for ${reference}: ${error.message}`, error.stack);
            // Re-throw to return 500 to Fincra so they retry
            throw error;
        }
    }

    async processAssetValueTransferToBankHandler(
        options: TransferFailedHandlerOptions
    ) {
        try {
            const transaction = await this.prisma.payment.findUnique({
                where: { reference: options.paymentReference },
            });
            if (!transaction) {
                throw new TransactionNotFoundException(
                    "transaction payment reference not found",
                    HttpStatus.NOT_FOUND
                );
            }

            if (transaction.paymentStatus === TransactionStatus.SUCCESS) {
                throw new DuplicateTransactionException(
                    "Duplicate transaction. Transaction already successful",
                    HttpStatus.CONFLICT
                );
            }

            await this.prisma.payment.update({
                where: {
                    reference: transaction.reference,
                },
                data: {
                    status: options.transferToBankStatus,
                    paymentStatus: options.transferToBankStatus,
                },
            });

            if (options.transferToBankStatus === TransactionStatus.SUCCESS) {
                const user = await this.prisma.user.findUnique({
                    where: { id: transaction.userId },
                });

                if (user) {
                    const message = this.notificationMessage.sellTransactionSuccess({
                        amount: +transaction.amount,
                        fiatAmount: +transaction.amount,
                        currency: "NGN",
                        transactionId: transaction.transactionId,
                        bankName: transaction.destinationBankAccountName,
                        accountNumber: transaction.destinationBankAccountNumber,
                    });

                    const createdNotification = await this.prisma.notification.create({
                        data: {
                            title: "Your payment is sent",
                            body: message,
                            userId: transaction.userId,
                            target: UserNotificationTarget.SINGLE,
                            beneficiary: NotificationBeneficiary.INDIVIDUAL,
                            type: NotificationType.MESSAGE,
                            status: NotificationStatus.APPROVED,
                            senderId: null,
                            transactionType: OrderCategory.SELL,
                            currency: "NGN",
                        },
                    });

                    this.notificationEvent.emit("transaction_notification", {
                        email: user.email,
                        notice: message,
                        transactionType: 'sell',
                        transactionId: transaction.transactionId,
                        amount: String(transaction.amount),
                        currency: 'NGN',
                        status: 'completed',
                        date: new Date().toISOString(),
                        fiatAmount: String(transaction.amount),
                        bankName: transaction.destinationBankAccountName || '',
                        accountNumber: transaction.destinationBankAccountNumber || '',
                    });

                    const notificationList = await this.prisma.notification.findMany({
                        where: { userId: transaction.userId },
                        orderBy: { createdAt: "desc" },
                        take: 20,
                    });

                    this.wsGateway.notifyUser(transaction.userId, {
                        type: "new_notification",
                        notification: createdNotification,
                        notificationList,
                    });
                }
            }
        } catch (error) {
            logger.error(error);
        }
    }

    async getAmountInNaira(
        asset: string,
        amount: number,
        rateType: "buy" | "sell" | "last" = "buy"
    ): Promise<{ amount?: number; rate?: number } | null> {
        const referenceCurrency = "ngn";
        const assetCurrency = asset.toLowerCase();
        const marketSymbol = `${assetCurrency}${referenceCurrency}`;
        const marketData = await this.quidaxService.getSingleMarketTicker(
            marketSymbol
        );

        const ticker = marketData.data?.ticker;
        if (!ticker) return null;

        const rate = parseFloat(ticker[rateType]);
        if (isNaN(rate)) return null;

        return {
            amount: amount * rate,
            rate: rate,
        };
    }
}
