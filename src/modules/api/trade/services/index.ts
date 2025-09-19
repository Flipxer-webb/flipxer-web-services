import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { buildResponse } from "@/utils/api-response-util";
import { PrismaService } from "@/modules/core/prisma/services";

import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import {
    AccountCreationException,
    AssetNotFoundException,
    GeneralTransactionException,
    IncompleteAccountSetupException,
    OutOfRangeException,
    TransactionCompletedException,
    TransactionNotFoundException,
    UnknownFeeStructureException,
    WalletAddressNotFoundException,
} from "../errors";
import {
    BuyQuoteResponse,
    DepositTransaction,
    getStreamlinedStatus,
    IWalletAddressCreatedSuccess,
    IWalletUpdated,
    OrderType,
    SellQuoteResponse,
    SupportedAssets,
    SwapTransactionHandlerOptions,
    TradingPair,
    WithdrawerTransactionHandlerOptions,
} from "../interfaces/trade";
import {
    CryptoWalletStatus,
    NetworkTypes,
    NotificationBeneficiary,
    NotificationStatus,
    NotificationType,
    OrderCategory,
    OrderSide,
    OrderStatus,
    PaymentMethod,
    TransactionFeeCategory,
    TransactionStatus,
    TransactionType,
    User,
    UserNotificationTarget,
} from "@prisma/client";
import {
    CancelWithdrawerRequestDto,
    ConfirmInstantSwapQuoteDto,
    GetCryptoWithdrawerFeeDto,
    GetWalletDto,
    InitiateBuyOrderDto,
    InitiateSellOrderDto,
    InitiateWalletCreationDto,
    PlaceInstantSwapRequestDto,
    PurchaseLimitBuyDto,
    RefreshInstantSwapRequestDto,
    SellCryptoOrderDto,
    SupportedPaymentMethodDto,
    VerifyWalletAddressDto,
    WithdrawerRequestDto,
} from "../dtos";
import { UserNotFoundException } from "../../user";
import { CryptoAccountQueueProducer } from "../queues/producers/producer.service";
import { GetPaymentAddressByIdOptions } from "@/libs/quidax";
import { generateId } from "@/utils";
import { BankInjectionToken } from "@/modules/factory/bank/types";
import { PaystackBank } from "@/modules/factory/bank/providers/paystack.provider";
import { PastackInitiationResponseResultType } from "@/modules/factory/bank/types/paystack";
import { COMPANY_NAME } from "@/config";
import {
    CryptoRateNotFoundException,
    CryptoTransactionFeeNotFoundException,
} from "../../settings/errors";
import { BankDetailNotFoundException } from "../../banks/errors";
import { NotificationEvent } from "../../notification/events/notification.event";
import { NotificationMessageService } from "@/modules/core/messages/services/notification.service";
import { WsGateway } from "../gateway/v1";

@Injectable()
export class TradingService {
    private readonly logger = new Logger("TradeService");
    constructor(
        private prisma: PrismaService,
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService,
        private readonly cryptoAccountQueueProducer: CryptoAccountQueueProducer,
        @Inject(BankInjectionToken.PAYSTACK)
        private readonly paystackService: PaystackBank,
        private readonly notificationEvent: NotificationEvent,
        private notificationMessage: NotificationMessageService,
        private readonly wsGateway: WsGateway
    ) {}

    getSupportedAssets() {
        const assets = Object.values(SupportedAssets);

        return buildResponse({
            message: "Supported assets retrieved",
            data: assets,
        });
    }

    async getSupportedPaymentMethod(query: SupportedPaymentMethodDto) {
        const result = await this.quidaxService.getPaymentMethods(query);

        return buildResponse({
            message: "Supported payment methods retrieved",
            data: result.data,
        });
    }

    async getPurchaseLimitForBuy(query: PurchaseLimitBuyDto) {
        const result = await this.quidaxService.getPurchaseLimitForBuy(query);

        return buildResponse({
            message: "Purchase limit retrieved",
            data: result.data,
        });
    }

    getSupportedNetworks() {
        const networks = Object.values(NetworkTypes);

        return buildResponse({
            message: "Supported networks retrieved",
            data: networks,
        });
    }

    getSupportedTradingPairs() {
        const tradingPair = Object.values(TradingPair);

        return buildResponse({
            message: "Supported Trading Pairs retrieved",
            data: tradingPair,
        });
    }

    async getWalletAddress(userId: number, dto: GetWalletDto) {
        const wallet = await this.prisma.cryptoWalletAddress.findUnique({
            where: {
                userId_assetSymbol_network: {
                    userId,
                    assetSymbol: dto.asset.toUpperCase(),
                    network: dto.network,
                },
            },
        });
        return buildResponse({
            message: "wallet info retrieved",
            data: wallet,
        });
    }

    async verifyWalletAddress(dto: VerifyWalletAddressDto) {
        const info = await this.quidaxService.verifyAddress({
            address: dto.address,
            currency: dto.currency,
        });

        return buildResponse({
            message: "wallet address info retrieved",
            data: info.data,
        });
    }

    async getCryptoWithdrawerFee(dto: GetCryptoWithdrawerFeeDto) {
        const info = await this.quidaxService.getWithdrawerFees({
            currency: dto.currency,
            ...(dto.network && { network: dto.network }),
        });

        return buildResponse({
            message: "withdrawer fee info retrieved",
            data: await this.getFee(dto.amount, info.data),
        });
    }

    async initiateWalletAddressCreation(
        userId: number,
        dto: InitiateWalletCreationDto
    ) {
        // const existingWallet = await this.prisma.cryptoWalletAddress.findUnique(
        //     {
        //         where: {
        //             userId_assetSymbol_network: {
        //                 userId,
        //                 assetSymbol: dto.asset.toUpperCase(),
        //                 network: dto.network,
        //             },
        //         },
        //     }
        // );

        // if (existingWallet) {
        //     return buildResponse({
        //         message: "wallet info retrieved",
        //         data: {
        //             status: "already_created",
        //             address: existingWallet,
        //         },
        //     });
        // }

        const user = await this.prisma.user.findUnique({
            where: { id: userId },
        });
        if (!user?.cryptoSubAccountId) {
            throw new UserNotFoundException(
                "User or sub-account not found",
                HttpStatus.NOT_FOUND
            );
        }

        const wallet = await this.quidaxService.createPaymentAddress({
            user_id: user.cryptoSubAccountId,
            currency: dto.asset.toLowerCase(),
            network: dto.network,
        });

        const cryptoWallet = await this.prisma.$transaction(
            async (tx) => {
                const cryptoWallet = await tx.cryptoWalletAddress.create({
                    data: {
                        assetSymbol: dto.asset.toUpperCase(),
                        walletAddressId: wallet.data.id,
                        userId: user.id,
                        network: wallet.data.network as NetworkTypes,
                    },
                });

                return cryptoWallet;
            },
            {
                timeout: 20000, // 20 seconds
            }
        );

        return buildResponse({
            message: "wallet address generation initiated",
            data: {
                walletGenerationStatus: "initiated",
                address: cryptoWallet,
            },
        });
    }

    async buyCryptoQuoteRequest(user: User, dto: InitiateBuyOrderDto) {
        const responseData = await this.calculateBuyQuote(user, dto);

        return buildResponse({
            message: "Quotation for buy order retrieved successfully",
            data: responseData,
        });
    }

    async sellCryptoQuoteRequest(user: User, dto: InitiateSellOrderDto) {
        const responseData = await this.calculateSellQuote(user, dto);

        return buildResponse({
            message: "Quotation for sell order retrieved successfully",
            data: responseData,
        });
    }

    async buyCryptoOrder(user: User, dto: InitiateBuyOrderDto) {
        const responseData = await this.calculateBuyQuote(user, dto);

        const userData = {
            id: user.id,
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
        };

        const amount = +responseData.totalToChargeViaPaymentGateway;
        Logger.log(`amount: ${typeof amount}`);
        const { data } = await this.paystackService.initializePaystackPayment(
            userData,
            amount
        );

        const result = data as unknown as PastackInitiationResponseResultType;

        const amtFiat = await this.getAmountInNaira(
            dto.asset,
            responseData.cryptoBuyAmount
        );

        const order = await this.prisma.$transaction(
            async (tx) => {
                const order = await tx.order.create({
                    data: {
                        orderCategory: OrderCategory.BUY,
                        transactionId: generateId({ type: "transaction" }),
                        amount: responseData.cryptoBuyAmount,
                        fee: responseData.transactionFeeInCrypto,
                        total: responseData.totalToChargeInCrypto,
                        status: OrderStatus.pending,
                        paymentStatus: TransactionStatus.PENDING,
                        currency: dto.asset.toUpperCase(),
                        recipient: responseData.depositAddress,
                        destinationTag: responseData.destinationTag,
                        userId: user.id,
                        amountInFiat: amtFiat?.amount,
                        rateAtConversion: amtFiat?.rate,
                    },
                });
                await tx.payment.create({
                    data: {
                        reference: result.reference,
                        userId: user.id,
                        amount:
                            responseData.buyRate * responseData.cryptoBuyAmount,
                        chargeFee:
                            responseData.buyRate *
                            responseData.transactionFeeInCrypto,
                        totalAmount:
                            responseData.totalToChargeViaPaymentGateway,
                        type: TransactionType.P2P_PAYMENT,
                        status: TransactionStatus.PENDING,
                        paymentStatus: TransactionStatus.PENDING,
                        paymentMethod: PaymentMethod.PAYSTACK,
                        sessionId: generateId({ type: "sessionId" }),
                        transactionId: generateId({ type: "transaction" }),
                        title: `${COMPANY_NAME} p2p buy order payment`,
                        narration: `Buy order payment for order with id ${order.id}`,
                        orderId: order.id,
                        isDebit: false,
                        expectedCurrency: responseData.currency,
                    },
                });

                return order;
            },
            { maxWait: 5000, timeout: 40000 }
        );

        return buildResponse({
            message:
                "Order placed successfully, Please proceed to make payment",
            data: {
                order: order,
                paymentInfo: data,
            },
        });
    }

    async sellCryptoOrder(user: User, dto: SellCryptoOrderDto) {
        const responseData = await this.calculateSellQuote(user, dto, true);

        const sendAmountToSeller = +responseData.totalToReceiveInFiat;
        const totalCryptoToAdmin = +responseData.totalCryptoToAdmin;

        //step 1: send crypto to admin quidax account
        const reference = generateId({ type: "reference" });
        const adminAssetWallet = await this.quidaxService.getUserWallet({
            user_id: "me",
            currency: dto.asset.toLowerCase(),
        });

        if (!adminAssetWallet.data.deposit_address) {
            await this.quidaxService.createPaymentAddress({
                user_id: "me",
                currency: dto.asset.toLowerCase(),
            });

            throw new GeneralTransactionException(
                "Destination crypto address is being set, Please try again",
                HttpStatus.BAD_REQUEST
            );
        }

        const requestRes = await this.quidaxService.createWithdrawerRequest({
            amount: totalCryptoToAdmin.toString(),
            currency: dto.asset.toLowerCase(),
            narration: "resolve sell order transaction",
            transaction_note: "resolve sell order transaction",
            user_id: user.cryptoSubAccountId,
            fund_uid: adminAssetWallet.data.deposit_address, //receiving wallet address //main account on quidax
            fund_uid2: adminAssetWallet.data.destination_tag, // destination tag
            reference: reference,
        });

        const amtFiat = await this.getAmountInNaira(
            dto.asset,
            responseData.cryptoSellAmount,
            "sell"
        );

        const order = await this.prisma.order.create({
            data: {
                orderCategory: OrderCategory.SELL,
                status: OrderStatus.processing,
                orderReference: reference,
                transactionId: generateId({ type: "transaction" }),
                providerOrderId: requestRes.data.id,
                userId: user.id,
                currency: requestRes.data.currency.toUpperCase(),
                narration: requestRes.data.narration,
                transaction_note: requestRes.data.transaction_note,
                recipient: requestRes.data.recipient.details.address,
                amount: +responseData.cryptoSellAmount,
                fee: +responseData.transactionFeeInCrypto,
                total: +responseData.totalCostInCrypto,
                totalToReceiveInFiat: sendAmountToSeller,
                sourceType: requestRes.data.type,
                destinationBankName: dto.bankDetail.bankName,
                destinationBankAccountNumber: dto.bankDetail.accountNumber,
                destinationBankAccountName: dto.bankDetail.accountName,
                destinationBankCode: dto.bankDetail.bankCode,
                amountInFiat: amtFiat?.amount,
                rateAtConversion: amtFiat?.rate,
            },
        });

        //step 2: once step 1 is successfully completed (webhook listener), send fund to user bank account from paystack main account

        return buildResponse({
            message: "Order placed successfully, Payment is processing",
            data: order,
        });
    }

    async calculateBuyQuote(
        user: User,
        dto: InitiateBuyOrderDto
    ): Promise<BuyQuoteResponse> {
        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "Please complete your account setup or contact admin for support",
                HttpStatus.BAD_REQUEST
            );
        }

        const assetExist = await this.prisma.assetWallet.findFirst({
            where: { userId: user.id, assetCurrency: dto.asset.toUpperCase() },
        });

        if (!assetExist) {
            throw new AssetNotFoundException(
                `Asset ${dto.asset} not found for the user`,
                HttpStatus.NOT_FOUND
            );
        }

        if (!assetExist.depositAddress || !assetExist.defaultNetwork) {
            throw new WalletAddressNotFoundException(
                `No wallet address found for asset ${dto.asset}`,
                HttpStatus.NOT_FOUND
            );
        }

        const currency = dto.asset.toUpperCase();
        // sell rate is used when user is buying.
        const [rate, adminFeeInCrypto] = await Promise.all([
            this.prisma.cryptoRate.findUnique({ where: { currency } }),
            this.prisma.transactionFee.findUnique({
                where: {
                    category_currency: {
                        category: TransactionFeeCategory.SELL,
                        currency,
                    },
                },
            }),
        ]);

        if (!rate) {
            throw new CryptoRateNotFoundException(
                `No rate found for asset ${dto.asset}`
            );
        }

        if (!adminFeeInCrypto) {
            throw new CryptoTransactionFeeNotFoundException(
                `No transaction fee record found for asset ${dto.asset}`
            );
        }

        const quidaxFeeRes = await this.quidaxService.getWithdrawerFees({
            currency: assetExist.assetCurrency.toLowerCase(),
            network: assetExist.defaultNetwork,
        });

        const quidaxFeeInCrypto = await this.getFee(
            dto.amount,
            quidaxFeeRes.data
        );

        const assetValueInNaira = dto.amount * rate.sellRate;
        const quidaxFeeInNaira = quidaxFeeInCrypto.fee * rate.sellRate;
        const adminFeeInNaira = adminFeeInCrypto.fee * rate.sellRate;

        const totalToChargeInCrypto =
            dto.amount + quidaxFeeInCrypto.fee + adminFeeInCrypto.fee;
        const totalToChargeViaPaymentGateway =
            assetValueInNaira + quidaxFeeInNaira + adminFeeInNaira;

        return {
            buyRate: rate.sellRate,
            cryptoBuyAmount: dto.amount,
            transactionFeeInCrypto:
                quidaxFeeInCrypto.fee + adminFeeInCrypto.fee,
            totalToChargeInCrypto,
            totalToChargeViaPaymentGateway,
            currency: "NGN",
            paymentGateway: PaymentMethod.PAYSTACK,
            depositAddress: assetExist.depositAddress,
            destinationTag: assetExist.destinationTag,
        };
    }

    async calculateSellQuote(
        user: User,
        dto: InitiateSellOrderDto,
        internal = false
    ): Promise<SellQuoteResponse> {
        // 1. Ensure crypto account is set up
        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "Please complete your account setup or contact admin for support",
                HttpStatus.BAD_REQUEST
            );
        }

        const currency = dto.asset.toUpperCase();

        // 2. Fetch bank detail, asset wallet, rate, and admin fee concurrently
        const [bankDetail, assetWallet, rate, adminFee] = await Promise.all([
            this.prisma.bankDetail.findFirst({
                where: { userId: user.id },
                select: {
                    accountName: true,
                    accountNumber: true,
                    bankName: true,
                },
            }),
            this.prisma.assetWallet.findFirst({
                where: {
                    userId: user.id,
                    assetCurrency: currency,
                },
            }),
            this.prisma.cryptoRate.findUnique({
                where: { currency },
            }),
            this.prisma.transactionFee.findUnique({
                where: {
                    category_currency: {
                        category: TransactionFeeCategory.BUY,
                        currency,
                    },
                },
            }),
        ]);

        // 3. Validate fetched records
        if (!bankDetail) {
            throw new BankDetailNotFoundException(
                "No bank detail found. Please setup your bank detail",
                HttpStatus.NOT_FOUND
            );
        }

        if (!assetWallet) {
            throw new AssetNotFoundException(
                `Asset ${dto.asset} not found for the user`,
                HttpStatus.NOT_FOUND
            );
        }

        const { depositAddress, defaultNetwork, assetCurrency } = assetWallet;

        if (!depositAddress || !defaultNetwork) {
            throw new WalletAddressNotFoundException(
                `No wallet address found for asset ${dto.asset}`,
                HttpStatus.NOT_FOUND
            );
        }

        if (!rate) {
            throw new CryptoRateNotFoundException(
                `No rate found for asset ${dto.asset}`
            );
        }

        if (!adminFee) {
            throw new CryptoTransactionFeeNotFoundException(
                `No transaction fee record found for asset ${dto.asset}`
            );
        }

        // 4. Fetch Quidax withdrawal fee and compute in crypto
        const { data: quidaxFeeData } =
            await this.quidaxService.getWithdrawerFees({
                currency: assetCurrency.toLowerCase(),
                network: defaultNetwork,
            });

        const { fee: quidaxFeeCrypto } = await this.getFee(
            dto.amount,
            quidaxFeeData
        );

        // 5. Calculations
        const buyRate = rate.buyRate;
        const adminFeeCrypto = adminFee.fee;

        const assetValueInNaira = dto.amount * buyRate;
        const quidaxFeeInNaira = quidaxFeeCrypto * buyRate;
        const adminFeeInNaira = adminFeeCrypto * buyRate;

        const totalCostInCrypto = dto.amount + quidaxFeeCrypto + adminFeeCrypto;
        const totalCostInFiat =
            assetValueInNaira + quidaxFeeInNaira + adminFeeInNaira;
        const totalCryptoToAdmin = dto.amount + adminFeeCrypto;

        // 6. Build response
        return {
            sellRate: buyRate,
            cryptoSellAmount: dto.amount,
            transactionFeeInCrypto: quidaxFeeCrypto + adminFeeCrypto,
            transactionFeeInFiat: quidaxFeeInNaira + adminFeeInNaira,
            totalCostInCrypto,
            totalCostInFiat,
            totalToReceiveInFiat: assetValueInNaira,
            currency: "NGN",
            bankDetail,
            ...(internal && { totalCryptoToAdmin }),
        };
    }

    async createInstantSwap(user: User, dto: PlaceInstantSwapRequestDto) {
        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "Please complete your account setup or contact admin for support",
                HttpStatus.BAD_REQUEST
            );
        }

        const swapInfo = await this.quidaxService.createInstantSwapRequest(
            user.cryptoSubAccountId,
            {
                from_currency: dto.from_currency,
                to_currency: dto.to_currency,
                ...(dto.from_amount && {
                    from_amount: dto.from_amount.toString(),
                }),
                ...(dto.to_amount && { to_amount: dto.to_amount?.toString() }),
            }
        );

        return buildResponse({
            message: "Swap request quote retrieved successfully",
            data: swapInfo.data,
        });
    }

    async refreshInstantSwap(user: User, dto: RefreshInstantSwapRequestDto) {
        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "Please complete your account setup or contact admin for support",
                HttpStatus.BAD_REQUEST
            );
        }

        const swapInfo = await this.quidaxService.refreshInstantSwapQuote(
            user.cryptoSubAccountId,
            dto.quotation_id,
            {
                from_currency: dto.from_currency,
                to_currency: dto.to_currency,
                ...(dto.from_amount && {
                    from_amount: dto.from_amount.toString(),
                }),
                ...(dto.to_amount && { to_amount: dto.to_amount?.toString() }),
            }
        );

        return buildResponse({
            message: "Swap request quote retrieved successfully",
            data: swapInfo.data,
        });
    }

    async withdrawerRequest(user: User, dto: WithdrawerRequestDto) {
        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "Please complete your account setup or contact admin for support",
                HttpStatus.BAD_REQUEST
            );
        }

        const reference = generateId({ type: "reference" });
        const requestRes = await this.quidaxService.createWithdrawerRequest({
            amount: dto.amount.toString(),
            currency: dto.currency,
            narration: dto.narration,
            transaction_note: dto.transaction_note,
            user_id: user.cryptoSubAccountId,
            fund_uid: dto.recipientWalletAddress, //receiving wallet address
            fund_uid2: dto.destinationTag, // destination tag
            reference: reference,
        });

        const amtFiat = await this.getAmountInNaira(
            requestRes.data.currency,
            Number(requestRes.data.amount),
            "sell"
        );

        const createdOrder = await this.prisma.order.create({
            data: {
                orderCategory: OrderCategory.SEND,
                status: OrderStatus.processing,
                orderReference: reference,
                transactionId: generateId({ type: "transaction" }),
                providerOrderId: requestRes.data.id,
                userId: user.id,
                currency: requestRes.data.currency,
                narration: requestRes.data.narration,
                transaction_note: requestRes.data.transaction_note,
                recipient: requestRes.data.recipient.details.address,
                amount: +requestRes.data.amount,
                fee: +requestRes.data.fee,
                total: +requestRes.data.total,
                sourceType: requestRes.data.type,
                amountInFiat: amtFiat?.amount,
                rateAtConversion: amtFiat?.rate,
            },
        });

        return buildResponse({
            message: "Withdrawer request placed successfully",
            data: {
                ...requestRes.data,
                transactionId: createdOrder.transactionId,
            },
        });
    }

    async cancelWithdrawerRequest(user: User, dto: CancelWithdrawerRequestDto) {
        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "Please complete your account setup or contact admin for support",
                HttpStatus.BAD_REQUEST
            );
        }

        const requestRes = await this.quidaxService.cancelWithdrawerRequest({
            user_id: user.cryptoSubAccountId,
            withdrawal_id: dto.withdrawal_id,
        });

        return buildResponse({
            message: "Withdrawer cancel request placed successfully",
            data: requestRes.data,
        });
    }

    async confirmInstantSwapQuote(user: User, dto: ConfirmInstantSwapQuoteDto) {
        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "Please complete your account setup or contact admin for support",
                HttpStatus.BAD_REQUEST
            );
        }

        const swapInfo = await this.quidaxService.confirmInstantSwap({
            quotation_id: dto.quotationId,
            user_id: user.cryptoSubAccountId,
        });

        const amtFiat = await this.getAmountInNaira(
            swapInfo.data.from_currency,
            Number(swapInfo.data?.from_amount),
            "sell"
        );
        const transactionId = generateId({ type: "transaction" });
        if (swapInfo.data) {
            this.prisma.$transaction(
                async (tx) => {
                    await tx.order.create({
                        data: {
                            orderCategory: OrderCategory.SWAP,
                            status: swapInfo.data.status,
                            transactionId: transactionId,
                            providerOrderId: swapInfo.data.id,
                            orderReference: generateId({
                                type: "reference",
                            }),
                            userId: user.id,
                            fromCurrency:
                                swapInfo.data.from_currency.toUpperCase(),
                            toCurrency: swapInfo.data.to_currency.toUpperCase(),
                            fromAmount: +swapInfo.data?.from_amount,
                            toAmount: +swapInfo.data?.received_amount,
                            amount: +swapInfo.data?.from_amount,
                            quotationId: swapInfo.data.swap_quotation.id,
                            quoted_currency:
                                swapInfo.data.swap_quotation.quoted_currency,
                            quoted_price:
                                +swapInfo.data.swap_quotation.quoted_price,
                            executionPrice: +swapInfo.data.execution_price,
                            amountInFiat: amtFiat?.amount,
                            rateAtConversion: amtFiat?.rate,
                        },
                    });
                },
                { maxWait: 5000, timeout: 20000 }
            );
        }

        return buildResponse({
            message: "Swap request processed successfully",
            data: {
                ...swapInfo.data,
                transactionId: transactionId,
            },
        });
    }

    async verifySwapQuoteTransaction(
        swap_transaction_id: string,
        user_id: string
    ) {
        const result = await this.quidaxService.getSwapTransaction({
            swap_transaction_id,
            user_id,
        });
        return result;
    }

    async getWithdrawerTransactionByReference(
        reference: string,
        user_id: string
    ) {
        const result = await this.quidaxService.getWithdrawerByReference({
            user_id,
            reference,
        });
        return result;
    }

    async triggerQuidaxAccountCreation(user: User) {
        if (user.cryptoSubAccountId) {
            throw new AccountCreationException(
                "Crypto account already created",
                HttpStatus.CONFLICT
            );
        }

        //create user quidax account and default wallet address once email is verified
        await this.cryptoAccountQueueProducer.enqueue(user.id);

        return buildResponse({
            message: "account generation initiated",
        });
    }

    // Handles successful wallet address creation webhook from Quidax
    async walletAddressCreatedSuccessHandler(
        data: IWalletAddressCreatedSuccess
    ) {
        // Step 1: Find the associated crypto wallet address record using the ID from the webhook
        const walletAddress = await this.prisma.cryptoWalletAddress.findUnique({
            where: { walletAddressId: data.walletAddressId },
            select: {
                id: true,
                assetSymbol: true,
                user: { select: { id: true, cryptoSubAccountId: true } },
            },
        });

        // Step 2: If wallet address is not found, throw an error
        if (!walletAddress) {
            this.logger.error("Crypto Wallet Address Record not found");
            return;
        }

        // Step 3: Check if an asset wallet already exists for this user and asset
        const assetWallet = await this.prisma.assetWallet.findUnique({
            where: {
                userId_assetCurrency: {
                    userId: walletAddress.user.id,
                    assetCurrency: walletAddress.assetSymbol.toUpperCase(),
                },
            },
            select: {
                id: true,
                quidaxWalletId: true,
                user: { select: { cryptoSubAccountId: true } },
            },
        });

        // Step 4: If no asset wallet exists, fetch wallet data from Quidax and create a new asset wallet
        if (!assetWallet) {
            const { status, data } = await this.quidaxService.getUserWallet({
                user_id: walletAddress.user.cryptoSubAccountId,
                currency: walletAddress.assetSymbol.toLowerCase(),
            });

            if (status === "success") {
                await this.prisma.assetWallet.create({
                    data: {
                        quidaxWalletId: data.id, // Quidax wallet ID
                        assetCurrency: data.currency.toUpperCase(),
                        assetName: data.name,
                        balance: data.balance,
                        locked: data.locked,
                        staked: data.staked,
                        convertedBalance: data.converted_balance,
                        blockchainEnabled: data.blockchain_enabled,
                        defaultNetwork: data.default_network,
                        isCrypto: data.is_crypto,
                        networks: data.networks, // List of network objects with deposit/withdraw status
                        referenceCurrency: data.reference_currency,
                        depositAddress: data.deposit_address, // Can be null initially
                        destinationTag: data.destination_tag,
                        userId: walletAddress.user.id,
                        ...(data.deposit_address && { addressSynced: true }), // Mark address as synced if present
                        ...(data.deposit_address && { isActive: true }), // Mark wallet as active if deposit address exists
                    },
                });
            }
        }

        // Step 5: Update the crypto wallet address record with the new address and mark it active
        await this.prisma.cryptoWalletAddress.update({
            where: { id: walletAddress.id },
            data: {
                address: data.walletAddress,
                ...(data.totalPayments && {
                    totalPayments: data.totalPayments, // Optional field if available
                }),
                destination_tag: data.destination_tag,
                status: CryptoWalletStatus.ACTIVE, // Mark as active
                lastSyncedAt: new Date(), // Timestamp of the last sync
            },
        });
    }

    async getGeneratedWalletAddress(data: GetPaymentAddressByIdOptions) {
        const result = await this.quidaxService.getPaymentAddressById(data);
        return result;
    }

    async walletUpdatedHandler(data: IWalletUpdated) {
        const wallet = await this.prisma.assetWallet.findUnique({
            where: { quidaxWalletId: data.walletId },
        });

        if (!wallet) {
            throw new WalletAddressNotFoundException(
                "Crypto Wallet Record not found",
                HttpStatus.NOT_FOUND
            );
        }

        await this.prisma.assetWallet.update({
            where: { id: wallet.id },
            data: {
                balance: data.balance,
                locked: data.locked,
                staked: data.staked,
                convertedBalance: data.convertedBalance,
                updatedAt: new Date(data.updatedAt),
                depositAddress: data.depositAddress, // Can be null initially
                destinationTag: data.destinationTag,
                ...(data.depositAddress && { addressSynced: true }), // Mark address as synced if present
                ...(data.depositAddress && { isActive: true }), // Mark wallet as active if deposit address exists
            },
        });
    }

    async depositHandler(options: DepositTransaction) {
        const user = await this.prisma.user.findUnique({
            where: { cryptoSubAccountId: options.quidaxUserId },
        });

        if (user) {
            const transaction = await this.prisma.order.findUnique({
                where: { providerOrderId: options.referenceId },
            });

            if (!transaction) {
                const amtFiat = await this.getAmountInNaira(
                    options.currency,
                    Number(options.amount),
                    "buy"
                );

                const transactionId = generateId({ type: "transaction" });
                await this.prisma.order.create({
                    data: {
                        orderCategory: OrderCategory.RECEIVE,
                        status: options.status,
                        transactionId: transactionId,
                        streamlinedStatus: getStreamlinedStatus(options.status),
                        providerOrderId: options.referenceId,
                        blockchain_txid: options.txid,
                        userId: user.id,
                        currency: options.currency.toUpperCase(),
                        reason: options.reason,
                        recipient: options.recipient,
                        sender: options.payment_address,
                        amount: +options.amount,
                        fee: +options.fee,
                        sourceType: options.type,
                        amountInFiat: amtFiat?.amount,
                        rateAtConversion: amtFiat?.rate,
                    },
                });

                if (options.status == OrderStatus.accepted) {
                    const message = this.notificationMessage.receiveTransaction(
                        {
                            amount: +options.amount,
                            currency: options.currency.toUpperCase(),
                            transactionId: transactionId,
                            sender: options.payment_address,
                        }
                    );

                    const createdNotification =
                        await this.prisma.notification.create({
                            data: {
                                title: "You've received a new payment",
                                body: message,
                                userId: user.id,
                                target: UserNotificationTarget.SINGLE,
                                beneficiary: NotificationBeneficiary.INDIVIDUAL,
                                type: NotificationType.MESSAGE,
                                status: NotificationStatus.APPROVED,
                                senderId: null,
                                transactionType: OrderCategory.RECEIVE,
                                currency: options.currency.toUpperCase(),
                            },
                        });

                    this.notificationEvent.emit("transaction_notification", {
                        email: user.email,
                        notice: message,
                    });

                    const notificationList =
                        await this.prisma.notification.findMany({
                            where: { userId: user.id },
                            orderBy: { createdAt: "desc" },
                            take: 20,
                        });

                    this.wsGateway.notifyUser(user.id, {
                        type: "new_notification",
                        notification: createdNotification,
                        notificationList,
                    });
                }
            } else {
                await this.prisma.order.update({
                    where: { id: transaction.id },
                    data: { status: options.status },
                });

                if (options.status == OrderStatus.accepted) {
                    const message = this.notificationMessage.receiveTransaction(
                        {
                            amount: +options.amount,
                            currency: options.currency.toUpperCase(),
                            transactionId: transaction.transactionId,
                            sender: options.payment_address,
                        }
                    );

                    const createdNotification =
                        await this.prisma.notification.create({
                            data: {
                                title: "You've received a new payment",
                                body: message,
                                userId: user.id,
                                target: UserNotificationTarget.SINGLE,
                                beneficiary: NotificationBeneficiary.INDIVIDUAL,
                                type: NotificationType.MESSAGE,
                                status: NotificationStatus.APPROVED,
                                senderId: null,
                                transactionType: OrderCategory.RECEIVE,
                                currency: options.currency.toUpperCase(),
                            },
                        });

                    this.notificationEvent.emit("transaction_notification", {
                        email: user.email,
                        notice: message,
                    });

                    const notificationList =
                        await this.prisma.notification.findMany({
                            where: { userId: user.id },
                            orderBy: { createdAt: "desc" },
                            take: 20,
                        });

                    this.wsGateway.notifyUser(user.id, {
                        type: "new_notification",
                        notification: createdNotification,
                        notificationList,
                    });
                }
            }
        }

        return buildResponse({
            message: "Deposit transaction logged successfully",
        });
    }

    async swapTransactionHandler(options: SwapTransactionHandlerOptions) {
        const transaction = await this.prisma.order.findUnique({
            where: { providerOrderId: options.orderId },
            include: { user: true },
        });

        if (!transaction) {
            throw new TransactionNotFoundException(
                "Transaction not found",
                HttpStatus.NOT_FOUND
            );
        }

        if (transaction.status === OrderStatus.completed) {
            throw new TransactionCompletedException(
                "Transaction already completed",
                HttpStatus.BAD_REQUEST
            );
        }

        if (transaction.status === options.status) {
            return;
        }
        await this.prisma.order.update({
            where: { id: transaction.id },
            data: {
                status: options.status,
                streamlinedStatus: getStreamlinedStatus(options.status),
            },
        });

        if (options.status == OrderStatus.completed) {
            const message = this.notificationMessage.swapTransactionSuccess({
                fromAmount: transaction.fromAmount,
                fromCurrency: transaction.fromCurrency,
                toAmount: transaction.toAmount,
                toCurrency: transaction.toCurrency,
                transactionId: transaction.transactionId,
            });

            const createdNotification = await this.prisma.notification.create({
                data: {
                    title: "Your swap transaction is completed",
                    body: message,
                    userId: transaction.user.id,
                    target: UserNotificationTarget.SINGLE,
                    beneficiary: NotificationBeneficiary.INDIVIDUAL,
                    type: NotificationType.MESSAGE,
                    status: NotificationStatus.APPROVED,
                    senderId: null,
                    transactionType: transaction.orderCategory,
                    currency: transaction.toCurrency,
                },
            });

            this.notificationEvent.emit("transaction_notification", {
                email: transaction.user.email,
                notice: message,
            });

            const notificationList = await this.prisma.notification.findMany({
                where: { userId: transaction.user.id },
                orderBy: { createdAt: "desc" },
                take: 20,
            });

            this.wsGateway.notifyUser(transaction.user.id, {
                type: "new_notification",
                notification: createdNotification,
                notificationList,
            });
        }
    }

    async withdrawerTransactionHandler(
        options: WithdrawerTransactionHandlerOptions
    ) {
        const transaction = await this.prisma.order.findUnique({
            where: { orderReference: options.orderReference },
            include: {
                user: { select: { id: true, email: true, userType: true } },
            },
        });

        if (!transaction) {
            throw new TransactionNotFoundException(
                "Transaction not found",
                HttpStatus.NOT_FOUND
            );
        }

        if (transaction.status === OrderStatus.done) {
            throw new TransactionCompletedException(
                "Transaction already completed",
                HttpStatus.BAD_REQUEST
            );
        }

        if (transaction.status === options.status) {
            return;
        }

        await this.prisma.order.update({
            where: { id: transaction.id },
            data: {
                status: options.status,
                streamlinedStatus: getStreamlinedStatus(options.status),
            },
        });

        //asset has been moved to admin wallet for a buy and seller needs to be paid
        if (
            options.status === OrderStatus.done &&
            transaction.orderCategory === OrderCategory.SELL
        ) {
            await this.paystackService.initializeTransfer({
                accountName: transaction.destinationBankAccountName,
                accountNumber: transaction.destinationBankAccountNumber,
                amount: transaction.totalToReceiveInFiat,
                bankCode: transaction.destinationBankCode,
                bankName: transaction.destinationBankName,
                serviceCharge: 0,
                userType: transaction.user.userType,
                userId: transaction.userId,
                orderId: transaction.id,
                reference: generateId({ type: "reference" }),
            });

            //follow up: listen to the transfer event and update transaction record accordingly
        }

        if (options.status == OrderStatus.done) {
            const message = this.notificationMessage.sendTransactionSuccess({
                amount: transaction.amount,
                currency: transaction.currency,
                recipient: transaction.recipient,
                transactionId: transaction.transactionId,
            });

            const createdNotification = await this.prisma.notification.create({
                data: {
                    title: "Your send transaction is done",
                    body: message,
                    userId: transaction.user.id,
                    target: UserNotificationTarget.SINGLE,
                    beneficiary: NotificationBeneficiary.INDIVIDUAL,
                    type: NotificationType.MESSAGE,
                    status: NotificationStatus.APPROVED,
                    senderId: null,
                    transactionType: transaction.orderCategory,
                    currency: transaction.currency,
                },
            });

            this.notificationEvent.emit("transaction_notification", {
                email: transaction.user.email,
                notice: message,
            });

            const notificationList = await this.prisma.notification.findMany({
                where: { userId: transaction.user.id },
                orderBy: { createdAt: "desc" },
                take: 20,
            });

            this.wsGateway.notifyUser(transaction.user.id, {
                type: "new_notification",
                notification: createdNotification,
                notificationList,
            });
        }
    }

    async getFee(
        amount: number,
        data: any
    ): Promise<{ fee: number; type: string }> {
        if (data.type === "flat" && typeof data.fee === "number") {
            return {
                fee: data.fee,
                type: "flat",
            };
        }

        if (data.type === "percentage" && typeof data.fee === "number") {
            return {
                fee: (amount * data.fee) / 100,
                type: "percentage",
            };
        }

        if (data.type === "range" && Array.isArray(data.fee)) {
            for (const range of data.fee) {
                if (amount >= range.min && amount < range.max) {
                    if (range.type === "percentage") {
                        return {
                            fee: (amount * range.value) / 100,
                            type: "percentage",
                        };
                    } else {
                        return {
                            fee: range.value,
                            type: "flat",
                        };
                    }
                }
            }

            throw new OutOfRangeException(
                "Amount is out of range.",
                HttpStatus.BAD_REQUEST
            );
        }

        throw new UnknownFeeStructureException(
            `Unknown fee type or structure. Received data: ${JSON.stringify(
                data
            )}`,
            HttpStatus.INTERNAL_SERVER_ERROR
        );
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
