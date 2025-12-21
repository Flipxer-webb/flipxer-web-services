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
import { SmsService } from "@/modules/core/sms/services";
import { MailService } from "@/modules/core/mail/services";

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
    constructor(
        private prisma: PrismaService,
        private smsService: SmsService,
        private mailService: MailService,
    ) {}

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

        // Get current security methods
        const currentUser = await this.prisma.user.findUnique({
            where: { id: user.id },
            select: { securityMethods: true },
        });
        const currentMethods = (currentUser?.securityMethods as any) || this.getDefaultSecurityMethods();

        // Now enable 2FA since the code is verified
        // Also auto-enable authenticator as a security method
        await this.prisma.user.update({
            where: { id: user.id },
            data: { 
                isTwoFactorEnabled: true,
                securityMethods: {
                    ...currentMethods,
                    authenticator: true,
                },
            },
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

    // ==================== Security Preferences ====================

    /**
     * Default security methods structure
     */
    private getDefaultSecurityMethods() {
        return {
            sms: false,
            email: false,
            authenticator: false,
            tradingPassword: false,
        };
    }

    /**
     * Get security preferences for the current user
     */
    async getSecurityPreferences(user: User) {
        const userData = await this.prisma.user.findUnique({
            where: { id: user.id },
            select: {
                securityMethods: true,
                requiredMethodCount: true,
                twoFactorBackupCodes: true,
                backupCodesGeneratedAt: true,
                isTwoFactorEnabled: true,
                isPhoneVerified: true,
                isEmailVerified: true,
                tradingPassword: true,
                tier: true,
            },
        });

        const securityMethods = (userData?.securityMethods as any) || this.getDefaultSecurityMethods();
        const backupCodes = userData?.twoFactorBackupCodes 
            ? JSON.parse(userData.twoFactorBackupCodes) 
            : [];

        // Calculate tier-based minimum required methods
        const tierMinimums: Record<number, number> = {
            0: 1,
            1: 1,
            2: 2,
            3: 2,
        };
        const minimumRequired = tierMinimums[userData?.tier ?? 0] || 1;

        return buildResponse({
            message: "Security preferences retrieved successfully",
            data: {
                methods: {
                    sms: {
                        enabled: securityMethods.sms || false,
                        available: userData?.isPhoneVerified || false,
                    },
                    email: {
                        enabled: securityMethods.email || false,
                        available: userData?.isEmailVerified || false,
                    },
                    authenticator: {
                        enabled: securityMethods.authenticator || false,
                        available: userData?.isTwoFactorEnabled || false,
                    },
                    tradingPassword: {
                        enabled: securityMethods.tradingPassword || false,
                        available: !!userData?.tradingPassword,
                    },
                },
                requiredMethodCount: userData?.requiredMethodCount ?? 1,
                minimumRequired,
                tier: userData?.tier ?? 0,
                backupCodesCount: backupCodes.length,
                backupCodesGeneratedAt: userData?.backupCodesGeneratedAt,
            },
        });
    }

    /**
     * Update security preferences (enable/disable methods)
     * Requires verification if disabling a method when only 2 are enabled
     */
    async updateSecurityPreferences(
        user: User, 
        dto: { methods?: any; requiredMethodCount?: number }
    ) {
        const userData = await this.prisma.user.findUnique({
            where: { id: user.id },
            select: {
                securityMethods: true,
                requiredMethodCount: true,
                tier: true,
                isPhoneVerified: true,
                isEmailVerified: true,
                isTwoFactorEnabled: true,
                tradingPassword: true,
            },
        });

        const currentMethods = (userData?.securityMethods as any) || this.getDefaultSecurityMethods();
        const newMethods = { ...currentMethods, ...dto.methods };

        // Validate: can't enable a method if prerequisite not met
        if (newMethods.sms && !userData?.isPhoneVerified) {
            throw new AuthGenericException(
                "Phone must be verified before enabling SMS security",
                HttpStatus.BAD_REQUEST
            );
        }
        if (newMethods.email && !userData?.isEmailVerified) {
            throw new AuthGenericException(
                "Email must be verified before enabling email security",
                HttpStatus.BAD_REQUEST
            );
        }
        if (newMethods.authenticator && !userData?.isTwoFactorEnabled) {
            throw new AuthGenericException(
                "Authenticator app must be set up before enabling it as a security method",
                HttpStatus.BAD_REQUEST
            );
        }
        if (newMethods.tradingPassword && !userData?.tradingPassword) {
            throw new AuthGenericException(
                "Trading password must be set before enabling it as a security method",
                HttpStatus.BAD_REQUEST
            );
        }

        // Count enabled methods
        const enabledCount = Object.values(newMethods).filter(Boolean).length;
        
        // Validate: at least one method must be enabled
        if (enabledCount === 0) {
            throw new AuthGenericException(
                "At least one security method must be enabled",
                HttpStatus.BAD_REQUEST
            );
        }

        // Validate requiredMethodCount
        const tierMinimums: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2 };
        const minimumRequired = tierMinimums[userData?.tier ?? 0] || 1;
        const newRequiredCount = dto.requiredMethodCount ?? userData?.requiredMethodCount ?? 1;

        if (newRequiredCount < minimumRequired) {
            throw new AuthGenericException(
                `Your tier requires at least ${minimumRequired} verification method(s)`,
                HttpStatus.BAD_REQUEST
            );
        }

        if (newRequiredCount > enabledCount) {
            throw new AuthGenericException(
                `Cannot require ${newRequiredCount} methods when only ${enabledCount} are enabled`,
                HttpStatus.BAD_REQUEST
            );
        }

        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                securityMethods: newMethods,
                requiredMethodCount: newRequiredCount,
            },
        });

        return buildResponse({
            message: "Security preferences updated successfully",
            data: {
                methods: newMethods,
                requiredMethodCount: newRequiredCount,
            },
        });
    }

    /**
     * Set or update trading password
     * Must be different from account password
     */
    async setTradingPassword(
        user: User,
        dto: { tradingPassword: string; accountPassword: string }
    ) {
        const userData = await this.prisma.user.findUnique({
            where: { id: user.id },
            select: { 
                password: true, 
                tradingPassword: true,
                securityMethods: true,
                twoFactorBackupCodes: true,
            },
        });

        // Verify account password
        const isPasswordValid = await bcrypt.compare(dto.accountPassword, userData?.password || "");
        if (!isPasswordValid) {
            throw new UserForbiddenException("Invalid account password", HttpStatus.FORBIDDEN);
        }

        // Ensure trading password is different from account password
        const isSameAsAccount = await bcrypt.compare(dto.tradingPassword, userData?.password || "");
        if (isSameAsAccount) {
            throw new AuthGenericException(
                "Trading password must be different from your account password",
                HttpStatus.BAD_REQUEST
            );
        }

        // Hash the trading password
        const hashedTradingPassword = await bcrypt.hash(dto.tradingPassword, 10);

        // Check if this is the first "advanced" security method (not SMS/Email)
        const isFirstAdvancedMethod = !userData?.tradingPassword && 
            !(userData?.securityMethods as any)?.authenticator;

        // Generate backup codes if first advanced method and no backup codes exist
        let backupCodes: string[] | null = null;
        let hashedBackupCodes: string[] | null = null;

        if (isFirstAdvancedMethod && !userData?.twoFactorBackupCodes) {
            backupCodes = generateBackupCodes(10);
            hashedBackupCodes = await hashBackupCodes(backupCodes);
        }

        // Update user
        const updateData: any = {
            tradingPassword: hashedTradingPassword,
        };

        if (hashedBackupCodes) {
            updateData.twoFactorBackupCodes = JSON.stringify(hashedBackupCodes);
            updateData.backupCodesGeneratedAt = new Date();
        }

        await this.prisma.user.update({
            where: { id: user.id },
            data: updateData,
        });

        const response: any = {
            message: userData?.tradingPassword 
                ? "Trading password updated successfully" 
                : "Trading password set successfully",
        };

        // Return backup codes if generated (one-time display)
        if (backupCodes) {
            response.data = {
                backupCodes,
                warning: "Save these backup codes in a secure location. You won't be able to see them again.",
            };
        }

        return buildResponse(response);
    }

    /**
     * Generate new backup codes (replaces existing)
     */
    async generateNewBackupCodes(user: User) {
        const backupCodes = generateBackupCodes(10);
        const hashedBackupCodes = await hashBackupCodes(backupCodes);

        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                twoFactorBackupCodes: JSON.stringify(hashedBackupCodes),
                backupCodesGeneratedAt: new Date(),
            },
        });

        return buildResponse({
            message: "New backup codes generated successfully",
            data: {
                backupCodes,
                warning: "Save these backup codes in a secure location. You won't be able to see them again.",
            },
        });
    }

    /**
     * Get backup codes count (not the codes themselves)
     */
    async getBackupCodesCount(user: User) {
        const userData = await this.prisma.user.findUnique({
            where: { id: user.id },
            select: { 
                twoFactorBackupCodes: true,
                backupCodesGeneratedAt: true,
            },
        });

        const backupCodes = userData?.twoFactorBackupCodes 
            ? JSON.parse(userData.twoFactorBackupCodes) 
            : [];

        return buildResponse({
            message: "Backup codes count retrieved",
            data: {
                count: backupCodes.length,
                generatedAt: userData?.backupCodesGeneratedAt,
            },
        });
    }

    /**
     * Verify a security method (unified endpoint)
     * Supports: sms, email, authenticator, tradingPassword, backupCode
     */
    async verifySecurityMethod(
        user: User,
        dto: { method: string; code: string }
    ): Promise<{ verified: boolean; method: string }> {
        const userData = await this.prisma.user.findUnique({
            where: { id: user.id },
            select: {
                twoFactorSecret: true,
                tradingPassword: true,
                twoFactorBackupCodes: true,
                phone: true,
                email: true,
            },
        });

        switch (dto.method) {
            case "authenticator":
                if (!userData?.twoFactorSecret) {
                    throw new AuthGenericException("Authenticator not set up", HttpStatus.BAD_REQUEST);
                }
                const isValidTotp = authenticator.verify({
                    token: dto.code,
                    secret: userData.twoFactorSecret,
                });
                if (!isValidTotp) {
                    throw new UserForbiddenException("Invalid authenticator code", HttpStatus.FORBIDDEN);
                }
                return { verified: true, method: "authenticator" };

            case "tradingPassword":
                if (!userData?.tradingPassword) {
                    throw new AuthGenericException("Trading password not set", HttpStatus.BAD_REQUEST);
                }
                const isValidPassword = await bcrypt.compare(dto.code, userData.tradingPassword);
                if (!isValidPassword) {
                    throw new UserForbiddenException("Invalid trading password", HttpStatus.FORBIDDEN);
                }
                return { verified: true, method: "tradingPassword" };

            case "backupCode":
                const isValidBackup = await this.verifyBackupCode(user.id, dto.code);
                if (!isValidBackup) {
                    throw new UserForbiddenException("Invalid or already used backup code", HttpStatus.FORBIDDEN);
                }
                return { verified: true, method: "backupCode" };

            case "sms":
            case "email":
                // These need to be verified via TransactionOTP - separate flow
                const isValidOtp = await this.verifyTransactionOtp(user.id, dto.method, dto.code);
                if (!isValidOtp) {
                    throw new UserForbiddenException("Invalid or expired OTP", HttpStatus.FORBIDDEN);
                }
                return { verified: true, method: dto.method };

            default:
                throw new AuthGenericException("Invalid security method", HttpStatus.BAD_REQUEST);
        }
    }

    /**
     * Send OTP for transaction verification (SMS or Email)
     */
    async sendTransactionOtp(user: User, method: "sms" | "email") {
        const userData = await this.prisma.user.findUnique({
            where: { id: user.id },
            select: { phone: true, email: true, isPhoneVerified: true, isEmailVerified: true },
        });

        if (method === "sms") {
            if (!userData?.isPhoneVerified || !userData?.phone) {
                throw new AuthGenericException("Phone not verified", HttpStatus.BAD_REQUEST);
            }
        } else if (method === "email") {
            if (!userData?.isEmailVerified || !userData?.email) {
                throw new AuthGenericException("Email not verified", HttpStatus.BAD_REQUEST);
            }
        }

        // Generate 6-digit OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

        // Store OTP in database (using existing pattern or create new table)
        // For simplicity, we'll use a pattern similar to PhoneVerificationRequest
        await this.prisma.$executeRaw`
            INSERT INTO "TransactionOTPs" ("userId", "method", "code", "expiresAt", "createdAt")
            VALUES (${user.id}, ${method}, ${otp}, ${expiresAt}, NOW())
            ON CONFLICT ("userId", "method") 
            DO UPDATE SET "code" = ${otp}, "expiresAt" = ${expiresAt}, "createdAt" = NOW()
        `;

        // Send OTP via appropriate channel
        if (method === "sms") {
            this.logger.log(`Sending transaction OTP via SMS to ${userData.phone}`);
            await this.smsService.sendVerificationCode(userData.phone!, otp);
        } else {
            this.logger.log(`Sending transaction OTP via email to ${userData.email}`);
            await this.mailService.sendMail({
                to: userData.email!,
                subject: "Flipxer Transaction Verification Code",
                text: `Your transaction verification code is: ${otp}. This code expires in 5 minutes.`,
                html: `
                    <h2>Transaction Verification</h2>
                    <p>Your transaction verification code is:</p>
                    <h1 style="font-size: 32px; letter-spacing: 4px; color: #3b82f6;">${otp}</h1>
                    <p>This code expires in 5 minutes.</p>
                    <p>If you did not request this code, please ignore this email.</p>
                `,
            });
        }

        return buildResponse({
            message: `OTP sent via ${method}`,
            data: {
                method,
                expiresIn: 300, // 5 minutes in seconds
            },
        });
    }

    /**
     * Verify transaction OTP (internal method)
     */
    private async verifyTransactionOtp(userId: number, method: string, code: string): Promise<boolean> {
        try {
            const result = await this.prisma.$queryRaw<Array<{ code: string; expiresAt: Date }>>`
                SELECT "code", "expiresAt" FROM "TransactionOTPs"
                WHERE "userId" = ${userId} AND "method" = ${method}
                LIMIT 1
            `;

            if (!result || result.length === 0) {
                return false;
            }

            const storedOtp = result[0];
            if (new Date() > storedOtp.expiresAt) {
                return false; // Expired
            }

            if (storedOtp.code !== code) {
                return false; // Wrong code
            }

            // Delete used OTP
            await this.prisma.$executeRaw`
                DELETE FROM "TransactionOTPs" WHERE "userId" = ${userId} AND "method" = ${method}
            `;

            return true;
        } catch (error) {
            this.logger.error(`Error verifying transaction OTP:`, error);
            return false;
        }
    }

    /**
     * Get security requirements for a transaction amount
     */
    async getTransactionSecurityRequirements(user: User, amount: number) {
        const userData = await this.prisma.user.findUnique({
            where: { id: user.id },
            select: {
                tier: true,
                securityMethods: true,
                requiredMethodCount: true,
            },
        });

        const tier = userData?.tier ?? 0;
        const securityMethods = (userData?.securityMethods as any) || this.getDefaultSecurityMethods();

        // Tier-based thresholds (in Naira)
        const thresholds: Record<number, number> = {
            0: 0,        // All transactions require verification
            1: 50000,    // ≥50,000 requires verification
            2: 100000,   // ≥100,000 requires verification
            3: 500000,   // ≥500,000 requires verification
        };

        const threshold = thresholds[tier] || 0;
        const requiresVerification = amount >= threshold;

        // Tier-based minimum methods
        const minimumMethods: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2 };
        const requiredCount = Math.max(
            userData?.requiredMethodCount ?? 1,
            minimumMethods[tier] || 1
        );

        // Get available methods
        const enabledMethods = Object.entries(securityMethods)
            .filter(([_, enabled]) => enabled)
            .map(([method]) => method);

        return buildResponse({
            message: "Transaction security requirements retrieved",
            data: {
                requiresVerification,
                threshold,
                amount,
                tier,
                requiredMethodCount: requiresVerification ? requiredCount : 0,
                enabledMethods,
            },
        });
    }
}
