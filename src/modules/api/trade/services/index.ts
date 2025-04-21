import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { buildResponse } from "@/utils/api-response-util";
import { PrismaService } from "@/modules/core/prisma/services";

import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import { WalletAddressNotFoundException } from "../errors";
import {
    IWalletAddressCreatedSuccess,
    SupportedAssets,
} from "../interfaces/trade";
import { CryptoWalletStatus, User } from "@prisma/client";
import { GetWalletDto } from "../dtos";
import { UserNotFoundException } from "../../user";

@Injectable()
export class TradingService {
    private readonly logger = new Logger("TradeService");
    constructor(
        private prisma: PrismaService,
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService
    ) {}

    getSupportedAssets() {
        const assets = Object.values(SupportedAssets);

        return buildResponse({
            message: "Supported assets retrieved",
            data: assets,
        });
    }

    async getWalletAddress(userId: number, dto: GetWalletDto) {
        const wallet = await this.prisma.cryptoWallet.findUnique({
            where: {
                userId_assetSymbol: {
                    userId,
                    assetSymbol: dto.asset,
                },
            },
        });

        return buildResponse({
            message: "wallet info retrieved",
            data: wallet,
        });
    }

    async initiateWalletCreation(userId: number, asset: string) {
        const existingWallet = await this.prisma.cryptoWallet.findUnique({
            where: {
                userId_assetSymbol: {
                    userId,
                    assetSymbol: asset,
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
                currency: asset.toLowerCase(),
            });

            const cryptoWallet = await tx.cryptoWallet.create({
                data: {
                    assetSymbol: asset.toUpperCase(),
                    walletId: wallet.data.id,
                    userId: user.id,
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
}
