import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { buildResponse } from "@/utils/api-response-util";
import { PrismaService } from "@/modules/core/prisma/services";
import {
    CryptoRateNotFoundException,
    CryptoTransactionFeeNotFoundException,
} from "../errors";
import {
    CreateOrUpdateCryptoRateDto,
    CreateOrUpdateCryptoTransactionFeeDto,
    GetCryptoTransactionFeePerAssetDto,
} from "../dtos";
import { TransactionFeeCategory } from "@prisma/client";

@Injectable()
export class SettingService {
    private readonly logger = new Logger("SettingService");
    constructor(private prisma: PrismaService) {}

    async getCryptoRateList() {
        const rates = await this.prisma.cryptoRate.findMany({
            select: {
                id: true,
                buyRate: true,
                sellRate: true,
                currency: true,
                createdAt: true,
            },
        });
        return buildResponse({
            message: "Crypto rate list retrieved",
            data: rates,
        });
    }

    async getCryptoRatePerAsset(asset_name: string) {
        const rate = await this.prisma.cryptoRate.findUnique({
            where: { currency: asset_name.toUpperCase() },
            select: {
                id: true,
                buyRate: true,
                sellRate: true,
                currency: true,
                createdAt: true,
            },
        });
        if (!rate) {
            throw new CryptoRateNotFoundException(
                `No rate found for asset ${asset_name}`
            );
        }
        return buildResponse({
            message: "Crypto rate retrieved",
            data: rate,
        });
    }

    async getCryptoTransactionFeesCategories() {
        const categories = Object.keys(TransactionFeeCategory);
        return buildResponse({
            message: "Crypto transaction fee categories retrieved",
            data: categories,
        });
    }

    async getCryptoTransactionFeeList() {
        const rates = await this.prisma.transactionFee.findMany({
            select: {
                id: true,
                category: true,
                currency: true,
                fee: true,
                createdAt: true,
            },
        });
        return buildResponse({
            message: "Crypto transaction fee list retrieved",
            data: rates,
        });
    }

    async getCryptoTransactionFeePerAsset(
        query: GetCryptoTransactionFeePerAssetDto,
        asset_name: string
    ) {
        const rate = await this.prisma.transactionFee.findUnique({
            where: {
                category_currency: {
                    category: query.category,
                    currency: asset_name.toUpperCase(),
                },
            },
            select: {
                id: true,
                category: true,
                fee: true,
                currency: true,
                createdAt: true,
            },
        });
        if (!rate) {
            throw new CryptoTransactionFeeNotFoundException(
                `No transaction fee record found for asset ${query.category} : ${asset_name}`
            );
        }
        return buildResponse({
            message: "Crypto transaction fee retrieved",
            data: rate,
        });
    }

    async getCryptoRateDetail(id: number) {
        const rateDetail = await this.prisma.cryptoRate.findUnique({
            where: { id: id },
        });

        if (!rateDetail) {
            throw new CryptoRateNotFoundException();
        }
        return buildResponse({
            message: "Crypto rate detail retrieved",
            data: rateDetail,
        });
    }

    async getCryptoTransactionFeeDetail(id: number) {
        const detail = await this.prisma.transactionFee.findUnique({
            where: { id: id },
        });

        if (!detail) {
            throw new CryptoTransactionFeeNotFoundException();
        }
        return buildResponse({
            message: "Crypto transaction fee detail retrieved",
            data: detail,
        });
    }

    async createOrUpdateCryptoRate(dto: CreateOrUpdateCryptoRateDto) {
        const result = await this.prisma.cryptoRate.upsert({
            where: { currency: dto.currency.toUpperCase() },
            update: {
                currency: dto.currency.toUpperCase(),
                buyRate: dto.buyRate,
                sellRate: dto.sellRate,
            },
            create: {
                currency: dto.currency.toUpperCase(),
                buyRate: dto.buyRate,
                sellRate: dto.sellRate,
            },
        });

        return buildResponse({
            message: "Crypto rate updated successfully",
            data: result,
        });
    }

    async createOrUpdateCryptoTransactionFee(
        dto: CreateOrUpdateCryptoTransactionFeeDto
    ) {
        const result = await this.prisma.transactionFee.upsert({
            where: {
                category_currency: {
                    category: dto.category,
                    currency: dto.currency.toUpperCase(),
                },
            },
            update: {
                category: dto.category,
                currency: dto.currency.toUpperCase(),
                fee: dto.fee,
            },
            create: {
                category: dto.category,
                currency: dto.currency.toUpperCase(),
                fee: dto.fee,
            },
        });

        return buildResponse({
            message: "Crypto transaction fee updated successfully",
            data: result,
        });
    }

    async deleteCryptoRate(id: number) {
        const rateDetail = await this.prisma.cryptoRate.findUnique({
            where: { id: id },
        });

        if (!rateDetail) {
            throw new CryptoRateNotFoundException();
        }

        await this.prisma.cryptoRate.delete({ where: { id: id } });

        return buildResponse({
            message: "Crypto rate removed successfully",
        });
    }

    async deleteCryptoTransactionFee(id: number) {
        const detail = await this.prisma.transactionFee.findUnique({
            where: { id: id },
        });

        if (!detail) {
            throw new CryptoTransactionFeeNotFoundException();
        }

        await this.prisma.transactionFee.delete({ where: { id: id } });

        return buildResponse({
            message: "Crypto transaction fee removed successfully",
        });
    }
}
