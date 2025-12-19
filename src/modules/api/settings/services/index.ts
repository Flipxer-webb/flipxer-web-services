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
    Enable2FADto,
    Disable2FADto,
} from "../dtos";
import { TransactionFeeCategory, User } from "@prisma/client";
import { UserForbiddenException, AuthGenericException } from "../../auth";
import * as ipaddr from "ipaddr.js";
import { authenticator } from "otplib";
import * as QRCode from "qrcode";
import * as bcrypt from "bcryptjs";
import { generateBackupCodes, hashBackupCodes, verifyBackupCode, removeUsedBackupCode } from "../../auth/utils/backup-codes.util";

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

    // ==================== Two-Factor Authentication ====================

    /**
     * Setup 2FA - Generate secret and return QR code URL
     * NOTE: This only stores the secret, does NOT enable 2FA yet.
     * User must verify the code via enable2FA to activate 2FA.
     */
    async setup2FA(user: User) {
        // Check if already enabled
        const existingUser = await this.prisma.user.findUnique({
            where: { id: user.id },
            select: { isTwoFactorEnabled: true },
        });

        if (existingUser?.isTwoFactorEnabled) {
            throw new AuthGenericException(
                "2FA is already enabled. Please disable it first if you want to re-configure it.",
                HttpStatus.BAD_REQUEST
            );
        }

        // Generate a new secret
        const secret = authenticator.generateSecret();
        
        // Create the otpauth URL for the authenticator app
        const appName = "Flipxer";
        const otpauthUrl = authenticator.keyuri(user.email, appName, secret);
        
        // Generate QR code as data URL
        const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

        // Generate backup codes (10 codes in format XXXX-XXXX-XX)
        const plainBackupCodes = generateBackupCodes(10);
        const hashedBackupCodes = await hashBackupCodes(plainBackupCodes);

        // Store the secret and hashed backup codes but DO NOT enable 2FA yet
        // 2FA will only be enabled after user verifies the code in enable2FA
        await this.prisma.user.update({
            where: { id: user.id },
            data: { 
                twoFactorSecret: secret,
                twoFactorBackupCodes: JSON.stringify(hashedBackupCodes),
                isTwoFactorEnabled: false,
            },
        });

        return buildResponse({
            message: "2FA setup initiated. Save your backup codes in a secure location. You won't be able to see them again.",
            data: {
                qrCodeUrl: qrCodeDataUrl,
                secret: secret, // Allow manual entry if QR scanning fails
                backupCodes: plainBackupCodes, // Display once, never show again
            },
        });
    }

    /**
     * Enable 2FA - Verify the code and enable 2FA for the user
     * This is the step that actually activates 2FA after the user proves
     * they have configured their authenticator app correctly.
     */
    async enable2FA(user: User, dto: Enable2FADto) {
        // Get user with secret
        const userWithSecret = await this.prisma.user.findUnique({
            where: { id: user.id },
            select: { twoFactorSecret: true, isTwoFactorEnabled: true },
        });

        if (!userWithSecret?.twoFactorSecret) {
            throw new UserForbiddenException(
                "Please set up 2FA first by generating a QR code",
                HttpStatus.FORBIDDEN
            );
        }

        // If already enabled, just verify the code works and return success
        if (userWithSecret.isTwoFactorEnabled) {
            const isValid = authenticator.verify({
                token: dto.code,
                secret: userWithSecret.twoFactorSecret,
            });

            if (!isValid) {
                throw new UserForbiddenException("Invalid verification code", HttpStatus.FORBIDDEN);
            }

            return buildResponse({
                message: "Two-factor authentication is already enabled",
            });
        }

        // Verify the TOTP code before enabling
        const isValid = authenticator.verify({
            token: dto.code,
            secret: userWithSecret.twoFactorSecret,
        });

        if (!isValid) {
            throw new UserForbiddenException("Invalid verification code", HttpStatus.FORBIDDEN);
        }

        // Now enable 2FA since the code is verified
        await this.prisma.user.update({
            where: { id: user.id },
            data: { isTwoFactorEnabled: true },
        });

        // Get backup codes count for response
        const userData = await this.prisma.user.findUnique({
            where: { id: user.id },
            select: { twoFactorBackupCodes: true },
        });
        
        const backupCodesCount = userData?.twoFactorBackupCodes 
            ? JSON.parse(userData.twoFactorBackupCodes).length 
            : 0;

        return buildResponse({
            message: "Two-factor authentication has been enabled successfully",
            data: {
                backupCodesRemaining: backupCodesCount,
            },
        });
    }

    /**
     * Disable 2FA - Verify code and password, then disable 2FA
     */
    async disable2FA(user: User, dto: Disable2FADto) {
        // Get user with secret and password
        const userWithData = await this.prisma.user.findUnique({
            where: { id: user.id },
            select: {
                twoFactorSecret: true,
                isTwoFactorEnabled: true,
                password: true,
            },
        });

        if (!userWithData?.isTwoFactorEnabled) {
            throw new UserForbiddenException("2FA is not enabled", HttpStatus.FORBIDDEN);
        }

        // Verify password
        const isPasswordValid = await bcrypt.compare(
            dto.password,
            userWithData.password
        );
        if (!isPasswordValid) {
            throw new UserForbiddenException("Invalid password", HttpStatus.FORBIDDEN);
        }

        // Verify the TOTP code
        const isValid = authenticator.verify({
            token: dto.code,
            secret: userWithData.twoFactorSecret,
        });

        if (!isValid) {
            throw new UserForbiddenException("Invalid verification code", HttpStatus.FORBIDDEN);
        }

        // Disable 2FA and clear secret
        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                isTwoFactorEnabled: false,
                twoFactorSecret: null,
            },
        });

        return buildResponse({
            message: "Two-factor authentication has been disabled successfully",
        });
    }

    /**
     * Get 2FA status for the current user
     */
    async get2FAStatus(user: User) {
        const userData = await this.prisma.user.findUnique({
            where: { id: user.id },
            select: { isTwoFactorEnabled: true },
        });

        return buildResponse({
            message: "2FA status retrieved successfully",
            data: {
                isEnabled: userData?.isTwoFactorEnabled ?? false,
            },
        });
    }

    /**
     * Verify 2FA code (used during login)
     */
    async verify2FACode(userId: number, code: string): Promise<boolean> {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { twoFactorSecret: true, isTwoFactorEnabled: true },
        });

        if (!user?.isTwoFactorEnabled || !user?.twoFactorSecret) {
            return true; // 2FA not enabled, allow login
        }

        return authenticator.verify({
            token: code,
            secret: user.twoFactorSecret,
        });
    }

    /**
     * Verify 2FA backup code and remove it after use
     */
    async verifyBackupCode(userId: number, code: string): Promise<boolean> {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { 
                twoFactorBackupCodes: true, 
                isTwoFactorEnabled: true 
            },
        });

        if (!user?.isTwoFactorEnabled || !user?.twoFactorBackupCodes) {
            return false;
        }

        try {
            const hashedCodes = JSON.parse(user.twoFactorBackupCodes) as string[];
            const matchIndex = await verifyBackupCode(code, hashedCodes);

            if (matchIndex === -1) {
                return false; // Code not found
            }

            // Remove the used backup code
            const updatedCodes = removeUsedBackupCode(hashedCodes, matchIndex);

            await this.prisma.user.update({
                where: { id: userId },
                data: { 
                    twoFactorBackupCodes: JSON.stringify(updatedCodes) 
                },
            });

            this.logger.log(`Backup code used for user ${userId}. ${updatedCodes.length} codes remaining.`);
            return true;
        } catch (error) {
            this.logger.error(`Error verifying backup code for user ${userId}:`, error);
            return false;
        }
    }

    /**
     * Verify 2FA code for transactions (withdrawals, sends, transfers)
     */
    async verify2FAForTransaction(user: User, dto: { code: string }) {
        const userData = await this.prisma.user.findUnique({
            where: { id: user.id },
            select: { twoFactorSecret: true, isTwoFactorEnabled: true },
        });

        if (!userData?.isTwoFactorEnabled || !userData?.twoFactorSecret) {
            throw new UserForbiddenException(
                "Two-factor authentication is not enabled on your account",
                HttpStatus.FORBIDDEN
            );
        }

        const isValid = authenticator.verify({
            token: dto.code,
            secret: userData.twoFactorSecret,
        });

        if (!isValid) {
            throw new UserForbiddenException(
                "Invalid verification code",
                HttpStatus.FORBIDDEN
            );
        }

        return buildResponse({
            message: "2FA verification successful",
            data: { verified: true },
        });
    }
}
