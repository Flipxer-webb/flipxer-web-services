import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { buildResponse } from "@/utils/api-response-util";
import { PrismaService } from "@/modules/core/prisma/services";

import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import {
    AccountCreationException,
    IncompleteAccountSetupException,
    WalletAddressNotFoundException,
} from "../errors";
import {
    IWalletAddressCreatedSuccess,
    IWalletUpdated,
    SupportedAssets,
    TradingPair,
} from "../interfaces/trade";
import {
    CryptoWalletStatus,
    NetworkTypes,
    OrderStatus,
    User,
} from "@prisma/client";
import {
    GetCryptoWithdrawerFeeDto,
    GetWalletDto,
    InitiateWalletCreationDto,
    PlaceBuyOrSellOrderDto,
    VerifyWalletAddressDto,
} from "../dtos";
import { UserNotFoundException } from "../../user";
import { CryptoAccountQueueProducer } from "../queues/producers/producer.service";

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
        const wallet = await this.prisma.cryptoWallet.findUnique({
            where: {
                userId_assetSymbol: {
                    userId,
                    assetSymbol: dto.asset.toUpperCase(),
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
            data: info.data,
        });
    }

    async initiateWalletCreation(
        userId: number,
        dto: InitiateWalletCreationDto
    ) {
        const existingWallet = await this.prisma.cryptoWallet.findUnique({
            where: {
                userId_assetSymbol: {
                    userId,
                    assetSymbol: dto.asset.toUpperCase(),
                },
            },
        });

        if (existingWallet) {
            return buildResponse({
                message: "wallet info retrieved",
                data: {
                    status: "already_created",
                    address: existingWallet,
                },
            });
        }

        const user = await this.prisma.user.findUnique({
            where: { id: userId },
        });
        if (!user?.cryptoSubAccountId) {
            throw new UserNotFoundException(
                "User or sub-account not found",
                HttpStatus.NOT_FOUND
            );
        }

        const cryptoWallet = await this.prisma.$transaction(async (tx) => {
            const wallet = await this.quidaxService.createPaymentAddress({
                user_id: user.cryptoSubAccountId,
                currency: dto.asset.toLowerCase(),
                network: dto.network,
            });

            const cryptoWallet = await tx.cryptoWallet.create({
                data: {
                    assetSymbol: dto.asset.toUpperCase(),
                    walletId: wallet.data.id,
                    userId: user.id,
                    defaultNetwork: wallet.data.network as NetworkTypes,
                },
            });

            return cryptoWallet;
        });

        return buildResponse({
            message: "wallet address generation initiated",
            data: {
                walletGenerationStatus: "initiated",
                address: cryptoWallet,
            },
        });
    }

    async buyOrSellCrypto(user: User, dto: PlaceBuyOrSellOrderDto) {
        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "Please complete your account setup or contact admin for support",
                HttpStatus.BAD_REQUEST
            );
        }

        //make api calll for buy or sell
        const order = await this.quidaxService.buyOrSellOrderRequest(
            user.cryptoSubAccountId,
            {
                market: dto.market,
                ord_type: dto.order_type,
                side: dto.order_side,
                volume: dto.volume,
                price: dto.price,
            }
        );

        if (order.data) {
            await this.prisma.order.create({
                data: {
                    orderType: dto.order_type,
                    market: dto.market,
                    orderSide: dto.order_side,
                    volume: dto.volume,
                    price: dto.price,
                    status: OrderStatus.pending,
                    providerOrderId: order.data.id,
                    orderReference: order.data.reference,
                    userId: user.id,
                },
            });
        }

        return buildResponse({
            message: "order placed successfully",
            data: {},
        });
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

    async walletAddressCreatedSuccessHandler(
        data: IWalletAddressCreatedSuccess
    ) {
        const walletAddress = await this.prisma.cryptoWallet.findUnique({
            where: { walletId: data.walletId },
        });

        if (!walletAddress) {
            throw new WalletAddressNotFoundException(
                "Crypto Wallet Record not found",
                HttpStatus.NOT_FOUND
            );
        }

        await this.prisma.cryptoWallet.update({
            where: { id: walletAddress.id },
            data: {
                address: data.walletAddress,
                balance: data.balance,
                ...(data.converted_balance && {
                    converted_balance: data.converted_balance,
                }),
                status: CryptoWalletStatus.ACTIVE,
            },
        });
    }

    async walletUpdatedHandler(data: IWalletUpdated) {
        const wallet = await this.prisma.cryptoWallet.findUnique({
            where: { walletId: data.walletId },
        });

        if (!wallet) {
            throw new WalletAddressNotFoundException(
                "Crypto Wallet Record not found",
                HttpStatus.NOT_FOUND
            );
        }

        await this.prisma.cryptoWallet.update({
            where: { id: wallet.id },
            data: {
                balance: data.balance,
                converted_balance: data.converted_balance,
            },
        });
    }
}
