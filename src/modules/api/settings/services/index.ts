import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { buildResponse } from "@/utils/api-response-util";
import { PrismaService } from "@/modules/core/prisma/services";
import {
    AllowedIpExistException,
    AllowedIpNotFoundException,
    CryptoRateNotFoundException,
    CryptoTransactionFeeNotFoundException,
    GenericAllowedIpException,
} from "../errors";
import {
    AddAllowedIpDto,
    CreateOrUpdateCryptoRateDto,
    CreateOrUpdateCryptoTransactionFeeDto,
    GetCryptoTransactionFeePerAssetDto,
    UpdateAllowedIpDto,
} from "../dtos";
import { TransactionFeeCategory, User } from "@prisma/client";
import { UserForbiddenException } from "../../auth";
import * as ipaddr from "ipaddr.js";

const NON_PUBLIC_IP_RANGES = new Set([
    "unspecified",
    "linkLocal",
    "loopback",
    "uniqueLocal",
    "broadcast",
    "carrierGradeNat",
    "private",
    "reserved",
    "multicast",
]);

const isPublicIp = (address: string) => {
    if (!ipaddr.isValid(address)) {
        return false;
    }
    const parsed = ipaddr.parse(address);
    return !NON_PUBLIC_IP_RANGES.has(parsed.range());
};

@Injectable()
export class SettingService {
    private readonly logger = new Logger("SettingService");
    constructor(private prisma: PrismaService) {}

    async getAllowedList(user: User) {
        const allowedIps = await this.prisma.allowedIp.findMany({
            where: { userId: user.id, isActive: true },
            select: {
                id: true,
                ip: true,
                isActive: true,
                label: true,
                userId: true,
            },
        });
        return buildResponse({
            message: "Allowed ips list retrieved",
            data: allowedIps,
        });
    }

    async addAllowedIp(user: User, dto: AddAllowedIpDto) {
        if (!isPublicIp(dto.ip)) {
            throw new GenericAllowedIpException(
                "Only public IPs are allowed.",
                HttpStatus.BAD_REQUEST
            );
        }

        const existingIp = await this.prisma.allowedIp.findUnique({
            where: {
                userId_ip: { userId: user.id, ip: dto.ip },
            },
        });

        if (existingIp?.isActive) {
            throw new AllowedIpExistException(
                "IP address already added and active."
            );
        }

        if (existingIp && !existingIp.isActive) {
            await this.prisma.allowedIp.update({
                where: { userId_ip: { userId: user.id, ip: dto.ip } },
                data: {
                    isActive: true,
                    label: dto.label ?? existingIp.label,
                    updatedAt: new Date(),
                },
            });
        }

        if (!existingIp) {
            await this.prisma.allowedIp.create({
                data: {
                    userId: user.id,
                    ip: dto.ip,
                    label: dto.label,
                },
            });
        }

        return buildResponse({
            message: "Allowed IP added successfully",
        });
    }

    async updateAllowedIp(
        user: User,
        ipAddress: string,
        dto: UpdateAllowedIpDto
    ) {
        const existingIp = await this.prisma.allowedIp.findUnique({
            where: { userId_ip: { userId: user.id, ip: ipAddress } },
        });

        if (!existingIp) {
            throw new AllowedIpNotFoundException("IP address not found");
        }

        const updated = await this.prisma.allowedIp.update({
            where: { userId_ip: { userId: user.id, ip: ipAddress } },
            data: {
                label: dto.label ?? existingIp.label,
                isActive: dto.isActive ?? existingIp.isActive,
            },
        });

        return buildResponse({
            message: "Allowed IP updated successfully",
            data: updated,
        });
    }

    async deleteAllowedIp(user: User, id: number) {
        const ipData = await this.prisma.allowedIp.findUnique({
            where: { id: id },
        });

        if (ipData.userId !== user.id) {
            throw new UserForbiddenException(
                "Can only be updated by the user that sets it",
                HttpStatus.FORBIDDEN
            );
        }

        if (!ipData) {
            throw new AllowedIpNotFoundException();
        }

        await this.prisma.allowedIp.update({
            where: { id: id },
            data: { isActive: false },
        });

        return buildResponse({
            message: "Allowed ip removed successfully",
        });
    }

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
