import {
    Injectable,
    ForbiddenException,
    NotFoundException,
    Inject,
    HttpStatus,
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

@Injectable()
export class BankService {
    constructor(
        private readonly prisma: PrismaService,
        @Inject(BankInjectionToken.FINCRA)
        private readonly fincraService: FincraBank,
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService
    ) {}

    async getListOfBanks() {
        const banks = await this.fincraService.getBanks();
        return buildResponse({
            message: "banks successfully retrieved",
            data: banks,
        });
    }

    async verifyBankAccount(options: VerifyBankAccountDto) {
        const account = await this.fincraService.resolveBankAccount({
            account_number: options.accountNumber,
            bank_code: options.bankCode,
        });

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
        try {
            const transaction = await this.prisma.payment.findUnique({
                where: { reference: reference },
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
                    include: { user: true },
                });

                await this.prisma.order.update({
                    where: { id: transaction.orderId },
                    data: {
                        paymentStatus: TransactionStatus.SUCCESS,
                        status: OrderStatus.confirmed,
                        streamlinedStatus: OrderStreamlinedStatus.completed,
                    },
                });

                if (order.orderCategory === OrderCategory.BUY) {
                    //admin sends asset to user wallet
                    const reference = generateId({ type: "reference" });
                    const requestRes =
                        await this.quidaxService.createWithdrawerRequest({
                            amount: order.amount.toString(),
                            currency: order.currency.toLowerCase(),
                            narration: "flipxer buy order transaction",
                            transaction_note: "flipxer buy order transaction",
                            user_id: "me", //main account on quidax
                            fund_uid: order.recipient, //receiving wallet address
                            fund_uid2: order.destinationTag, // destination tag
                            reference: reference,
                        });

                    const amtFiat = await this.getAmountInNaira(
                        requestRes.data.currency,
                        Number(requestRes.data.amount)
                    );

                    await this.prisma.order.create({
                        data: {
                            orderCategory: OrderCategory.SELL,
                            status: OrderStatus.processing,
                            orderReference: reference,
                            transactionId: generateId({ type: "transaction" }),
                            providerOrderId: requestRes.data.id,
                            userId: admin.id,
                            currency: requestRes.data.currency.toUpperCase(),
                            narration: requestRes.data.narration,
                            transaction_note: requestRes.data.transaction_note,
                            recipient:
                                requestRes.data.recipient.details.address,
                            amount: +requestRes.data.amount,
                            fee: +requestRes.data.fee,
                            total: +requestRes.data.total,
                            sourceType: requestRes.data.type,
                            amountInFiat: amtFiat?.amount,
                            rateAtConversion: amtFiat?.rate,
                        },
                    });
                }
            }
        } catch (error) {
            logger.error(error);
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

            // if (options.transferToBankStatus == TransactionStatus.SUCCESS) {
            //     const message = this.notificationMessage.fiatPaymentSuccess({
            //         amount: +transaction.amount,
            //         accountNumber: transaction.destinationBankAccountNumber,
            //         bankName: transaction.destinationBankAccountName,
            //         transactionId: transaction.transactionId,
            //     });

            //     await this.prisma.notification.create({
            //         data: {
            //             title: "Your payment is sent",
            //             body: message,
            //             userId: transaction.userId,
            //             target: UserNotificationTarget.SINGLE,
            //             beneficiary: NotificationBeneficiary.INDIVIDUAL,
            //             type: NotificationType.MESSAGE,
            //             status: NotificationStatus.APPROVED,
            //             senderId: null,
            //         },
            //     });

            //     this.notificationEvent.emit("transaction_notification", {
            //         email: admin.email,
            //         notice: message,
            //     });
            // }
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
