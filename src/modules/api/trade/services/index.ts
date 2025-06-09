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
    IWalletAddressCreatedSuccess,
    IWalletUpdated,
    SupportedAssets,
    SwapTransactionHandlerOptions,
    TradingPair,
    WithdrawerTransactionHandlerOptions,
} from "../interfaces/trade";
import {
    CryptoWalletStatus,
    NetworkTypes,
    OrderCategory,
    OrderSide,
    OrderStatus,
    PaymentMethod,
    User,
} from "@prisma/client";
import {
    CancelWithdrawerRequestDto,
    ConfirmInstantSwapQuoteDto,
    GetCryptoWithdrawerFeeDto,
    GetWalletDto,
    InitiateBuyOrderDto,
    InitiateWalletCreationDto,
    PlaceInstantSwapRequestDto,
    PurchaseLimitBuyDto,
    RefreshInstantSwapRequestDto,
    SupportedPaymentMethodDto,
    VerifyWalletAddressDto,
    WithdrawerRequestDto,
} from "../dtos";
import { UserNotFoundException } from "../../user";
import { CryptoAccountQueueProducer } from "../queues/producers/producer.service";
import { GetPaymentAddressByIdOptions } from "@/libs/quidax";
import { generateId } from "@/utils";

@Injectable()
export class TradingService {
    private readonly logger = new Logger("TradeService");
    constructor(
        private prisma: PrismaService,
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService,
        private readonly cryptoAccountQueueProducer: CryptoAccountQueueProducer
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

    async buyCrypto(user: User, dto: InitiateBuyOrderDto) {
        const responseData = await this.calculateBuyQuote(user, dto);

        return buildResponse({
            message: "Quotation for order retrieved successfully",
            data: responseData,
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

        // TODO: Fetch these from admin settings
        const buyRate = 1750; // 1 crypto = NGN
        const adminFeeInCrypto = 0.1; // flat crypto fee

        const quidaxFeeRes = await this.quidaxService.getWithdrawerFees({
            currency: assetExist.assetCurrency.toLowerCase(),
            network: assetExist.defaultNetwork,
        });

        const quidaxFeeInCrypto = await this.getFee(
            dto.amount,
            quidaxFeeRes.data
        );

        const assetValueInNaira = dto.amount * buyRate;
        const quidaxFeeInNaira = quidaxFeeInCrypto.fee * buyRate;
        const adminFeeInNaira = adminFeeInCrypto * buyRate;

        const totalToChargeInCrypto =
            dto.amount + quidaxFeeInCrypto.fee + adminFeeInCrypto;
        const totalToChargeViaPaymentGateway =
            assetValueInNaira + quidaxFeeInNaira + adminFeeInNaira;

        return {
            buyRate,
            cryptoBuyAmount: dto.amount,
            transactionFeeInCrypto: quidaxFeeInCrypto.fee + adminFeeInCrypto,
            totalToChargeInCrypto,
            totalToChargeViaPaymentGateway,
            currency: "NGN",
            paymentGateway: PaymentMethod.PAYSTACK,
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

        await this.prisma.order.create({
            data: {
                orderCategory: OrderCategory.SEND,
                status: OrderStatus.processing,
                orderReference: reference,
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
            },
        });

        return buildResponse({
            message: "Withdrawer request placed successfully",
            data: requestRes.data,
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

        if (swapInfo.data) {
            this.prisma.$transaction(
                async (tx) => {
                    await tx.order.create({
                        data: {
                            orderCategory: OrderCategory.SWAP,
                            status: swapInfo.data.status,
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
                            quotationId: swapInfo.data.swap_quotation.id,
                            quoted_currency:
                                swapInfo.data.swap_quotation.quoted_currency,
                            quoted_price:
                                +swapInfo.data.swap_quotation.quoted_price,
                            executionPrice: +swapInfo.data.execution_price,
                        },
                    });
                },
                { maxWait: 5000, timeout: 20000 }
            );
        }

        return buildResponse({
            message: "Swap request processed successfully",
            data: swapInfo.data,
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
                await this.prisma.order.create({
                    data: {
                        orderCategory: OrderCategory.RECEIVE,
                        status: options.status,
                        providerOrderId: options.referenceId,
                        blockchain_txid: options.txid,
                        userId: user.id,
                        currency: options.currency.toUpperCase(),
                        reason: options.reason,
                        recipient: options.recipient,
                        amount: +options.amount,
                        fee: +options.fee,
                        sourceType: options.type,
                    },
                });
            } else {
                await this.prisma.order.update({
                    where: { id: transaction.id },
                    data: { status: options.status },
                });
            }
        }

        return buildResponse({
            message: "Deposit transaction logged successfully",
        });
    }

    async swapTransactionHandler(options: SwapTransactionHandlerOptions) {
        const transaction = await this.prisma.order.findUnique({
            where: { providerOrderId: options.orderId },
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
            },
        });
    }

    async withdrawerTransactionHandler(
        options: WithdrawerTransactionHandlerOptions
    ) {
        const transaction = await this.prisma.order.findUnique({
            where: { orderReference: options.orderReference },
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
            },
        });
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

        if (data.type === "range" && Array.isArray(data.fee)) {
            for (const range of data.fee) {
                if (amount >= range.min && amount < range.max) {
                    return {
                        fee: range.value,
                        type: "flat", // all ranges from Quidax return "flat"
                    };
                }
            }

            throw new OutOfRangeException(
                "Amount is out of range.",
                HttpStatus.BAD_REQUEST
            );
        }

        throw new UnknownFeeStructureException(
            "Unknown fee type or structure.",
            HttpStatus.INTERNAL_SERVER_ERROR
        );
    }
}
