/**
 * Tier Verification Service
 * Handles Tier 2/3 verification flows: address and income verification
 */

import { HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { DocumentVerificationStatus, User } from "@prisma/client";
import { ApiResponse, buildResponse } from "@/utils/api-response-util";
import { UploadFactory } from "@/modules/core/upload/services";
import { ImagekitService } from "@/modules/core/upload/services/imagekit";
import { CloudinaryService } from "@/modules/core/upload/services/cloudinary";
import { storageDirConfig, emailTemplateConfig, COMPANY_NAME, mailConfig } from "@/config";
import { generateRandomNum } from "@/utils";
import { EmailService } from "@/modules/core/email/services";
import {
    validateDocumentFile,
} from "@/core/validators/file-validator";
import {
    validateAddressDocument,
    validateIncomeDocument,
} from "@/libs/ocr";
import {
    CreateTradingPasswordDto,
} from "../dtos";
import { TierService } from "./tier.service";
import * as bcrypt from "bcryptjs";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import { WsGateway } from "@/modules/api/trade/gateway/v1";

type DocumentType = "address" | "income" | "business";

@Injectable()
export class TierVerificationService {
    private readonly logger = new Logger(TierVerificationService.name);
    private readonly uploadService: ImagekitService | CloudinaryService;
    private readonly SALT_ROUNDS = 10;

    constructor(
        private readonly prisma: PrismaService,
        private readonly uploadFactory: UploadFactory,
        private readonly tierService: TierService,
        private readonly emailService: EmailService,
        private readonly notificationDispatcher: NotificationDispatcher,
        private readonly wsGateway: WsGateway,
    ) {
        this.uploadService = this.uploadFactory.build({
            provider: "imagekit",
        });
    }

    /**
     * Upload and validate address document for Tier 2 verification
     */
    async verifyAddress(
        user: User,
        file: Express.Multer.File
    ): Promise<ApiResponse> {
        // Check if already verified
        if (user.isAddressVerified) {
            return buildResponse({
                message: "Address is already verified",
            });
        }

        // Validate file
        const fileValidation = validateDocumentFile({
            buffer: file.buffer,
            mimetype: file.mimetype,
            size: file.size,
            originalname: file.originalname,
        });

        if (!fileValidation.isValid) {
            throw new HttpException(
                fileValidation.error || "Invalid file",
                HttpStatus.BAD_REQUEST
            );
        }

        // Upload document
        const uploadResult = await this.uploadDocument(file, "address");
        const documentUrl = uploadResult.url;

        // Run OCR validation
        const ocrResult = await validateAddressDocument(
            file.buffer,
            user.firstName || "",
            user.lastName || ""
        );

        this.logger.log(
            `Address OCR result for user ${user.id}: confidence=${ocrResult.confidence}, matchedName=${ocrResult.matchedName}, matchedAddress=${ocrResult.matchedAddress}`
        );

        if (ocrResult.requiresManualReview) {
            // Flag for manual review
            await this.prisma.user.update({
                where: { id: user.id },
                data: {
                    addressDocumentUrl: documentUrl,
                    addressVerificationStatus: DocumentVerificationStatus.PENDING,
                },
            });

            // Create KycVerification record for audit trail
            await this.prisma.kycVerification.create({
                data: {
                    userId: user.id,
                    verificationType: "ADDRESS",
                    status: "PENDING",
                    documentUrl,
                },
            });

            // In-app notification for pending review
            await this.notificationDispatcher.notify({
                userId: user.id,
                title: "Document Submitted",
                body: "Your address document has been submitted for review. We'll notify you once it's processed.",
                category: "security",
            });

            return buildResponse({
                message:
                    "Document uploaded successfully. It will be reviewed by our team.",
                data: {
                    status: "PENDING",
                    reason: ocrResult.reason,
                },
            });
        }

        // Auto-approve
        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                addressDocumentUrl: documentUrl,
                addressVerificationStatus: DocumentVerificationStatus.VERIFIED,
                isAddressVerified: true,
            },
        });

        // Create KycVerification record for auto-approved
        await this.prisma.kycVerification.create({
            data: {
                userId: user.id,
                verificationType: "ADDRESS",
                status: "APPROVED",
                documentUrl,
                reviewedAt: new Date(),
                reviewNote: "Auto-approved via OCR verification",
            },
        });

        // Sync tier & flush cache
        await this.tierService.syncTierAndCache(user.id);

        // Email + in-app notification + WS push on auto-approval
        if (emailTemplateConfig.document_approved) {
            this.emailService.sendMailWithTemplate({
                from: { address: mailConfig.senderMail },
                to: [{ email_address: { address: user.email } }],
                template_key: emailTemplateConfig.document_approved,
                merge_info: {
                    first_name: user.firstName || "User",
                    document_type: "Address",
                    company_name: COMPANY_NAME,
                    rejection_reason: "",
                    status: "Approved",
                },
            }).catch((e) => this.logger.error(`[KYC][ADDRESS] Failed to send approval email for user ${user.id}: ${e instanceof Error ? e.message : String(e)}`));
        }
        this.notificationDispatcher.notify({
            userId: user.id,
            title: "Address Verified",
            body: "Your address verification has been approved.",
            category: "security",
            enablePush: true,
        }).catch((e) => this.logger.error(`[KYC][ADDRESS] Failed to send notification for user ${user.id}: ${e instanceof Error ? e.message : String(e)}`));
        this.wsGateway.notifyProfileUpdate(user.id);

        return buildResponse({
            message: "Address verified successfully",
            data: {
                status: "VERIFIED",
            },
        });
    }

    /**
     * Upload and validate income document for Tier 3 verification
     */
    async verifyIncome(
        user: User,
        file: Express.Multer.File
    ): Promise<ApiResponse> {
        // Check if already verified
        if (user.isIncomeVerified) {
            return buildResponse({
                message: "Income is already verified",
            });
        }

        // Validate file
        const fileValidation = validateDocumentFile({
            buffer: file.buffer,
            mimetype: file.mimetype,
            size: file.size,
            originalname: file.originalname,
        });

        if (!fileValidation.isValid) {
            throw new HttpException(
                fileValidation.error || "Invalid file",
                HttpStatus.BAD_REQUEST
            );
        }

        // Upload document
        const uploadResult = await this.uploadDocument(file, "income");
        const documentUrl = uploadResult.url;

        // Run OCR validation
        const ocrResult = await validateIncomeDocument(
            file.buffer,
            user.firstName || "",
            user.lastName || ""
        );

        this.logger.log(
            `Income OCR result for user ${user.id}: confidence=${ocrResult.confidence}, matchedName=${ocrResult.matchedName}`
        );

        if (ocrResult.requiresManualReview) {
            // Flag for manual review
            await this.prisma.user.update({
                where: { id: user.id },
                data: {
                    incomeDocumentUrl: documentUrl,
                    incomeVerificationStatus: DocumentVerificationStatus.PENDING,
                },
            });

            // Create KycVerification record for audit trail
            await this.prisma.kycVerification.create({
                data: {
                    userId: user.id,
                    verificationType: "INCOME",
                    status: "PENDING",
                    documentUrl,
                },
            });

            // In-app notification for pending review
            await this.notificationDispatcher.notify({
                userId: user.id,
                title: "Document Submitted",
                body: "Your income document has been submitted for review. We'll notify you once it's processed.",
                category: "security",
            });

            return buildResponse({
                message:
                    "Document uploaded successfully. It will be reviewed by our team.",
                data: {
                    status: "PENDING",
                    reason: ocrResult.reason,
                },
            });
        }

        // Auto-approve
        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                incomeDocumentUrl: documentUrl,
                incomeVerificationStatus: DocumentVerificationStatus.VERIFIED,
                isIncomeVerified: true,
            },
        });

        // Create KycVerification record for auto-approved
        await this.prisma.kycVerification.create({
            data: {
                userId: user.id,
                verificationType: "INCOME",
                status: "APPROVED",
                documentUrl,
                reviewedAt: new Date(),
                reviewNote: "Auto-approved via OCR verification",
            },
        });

        // Sync tier & flush cache
        await this.tierService.syncTierAndCache(user.id);

        // Email + in-app notification + WS push on auto-approval
        if (emailTemplateConfig.document_approved) {
            this.emailService.sendMailWithTemplate({
                from: { address: mailConfig.senderMail },
                to: [{ email_address: { address: user.email } }],
                template_key: emailTemplateConfig.document_approved,
                merge_info: {
                    first_name: user.firstName || "User",
                    document_type: "Income",
                    company_name: COMPANY_NAME,
                    rejection_reason: "",
                    status: "Approved",
                },
            }).catch((e) => this.logger.error(`[KYC][INCOME] Failed to send approval email for user ${user.id}: ${e instanceof Error ? e.message : String(e)}`));
        }
        this.notificationDispatcher.notify({
            userId: user.id,
            title: "Income Verified",
            body: "Your income verification has been approved.",
            category: "security",
            enablePush: true,
        }).catch((e) => this.logger.error(`[KYC][INCOME] Failed to send notification for user ${user.id}: ${e instanceof Error ? e.message : String(e)}`));
        this.wsGateway.notifyProfileUpdate(user.id);

        return buildResponse({
            message: "Income verified successfully",
            data: {
                status: "VERIFIED",
            },
        });
    }

    /**
     * Create or update trading password
     */
    async createTradingPassword(
        user: User,
        dto: CreateTradingPasswordDto
    ): Promise<ApiResponse> {
        if (dto.tradingPassword !== dto.confirmTradingPassword) {
            throw new HttpException(
                "Passwords do not match",
                HttpStatus.BAD_REQUEST
            );
        }

        const hashedPassword = await bcrypt.hash(
            dto.tradingPassword,
            this.SALT_ROUNDS
        );

        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                tradingPassword: hashedPassword,
            },
        });

        this.logger.log(`Trading password created for user ${user.id}`);

        return buildResponse({
            message: "Trading password created successfully",
        });
    }

    /**
     * Check if user has trading password set
     */
    async hasTradingPassword(user: User): Promise<ApiResponse> {
        const userWithPassword = await this.prisma.user.findUnique({
            where: { id: user.id },
            select: { tradingPassword: true },
        });

        return buildResponse({
            message: "Trading password status",
            data: {
                hasTradingPassword: !!userWithPassword?.tradingPassword,
            },
        });
    }

    /**
     * Get verification status for tier upgrades
     */
    async getVerificationStatus(user: User): Promise<ApiResponse> {
        const userWithStatus = await this.prisma.user.findUnique({
            where: { id: user.id },
            select: {
                isAddressVerified: true,
                isIncomeVerified: true,
                addressVerificationStatus: true,
                incomeVerificationStatus: true,
                tradingPassword: true,
                tier: true,
            },
        });

        if (!userWithStatus) {
            throw new HttpException("User not found", HttpStatus.NOT_FOUND);
        }

        return buildResponse({
            message: "Verification status",
            data: {
                tier: userWithStatus.tier,
                address: {
                    verified: userWithStatus.isAddressVerified,
                    status: userWithStatus.addressVerificationStatus,
                },
                income: {
                    verified: userWithStatus.isIncomeVerified,
                    status: userWithStatus.incomeVerificationStatus,
                },
                hasTradingPassword: !!userWithStatus.tradingPassword,
            },
        });
    }

    /**
     * Upload document to storage
     */
    private async uploadDocument(
        file: Express.Multer.File,
        type: "address" | "income"
    ) {
        const date = Date.now();
        const result = await this.uploadService.uploadCompressedImage({
            dir: `${storageDirConfig.document}/${type}`,
            name: `${type}-doc-${date}-${generateRandomNum(5)}`,
            format: "webp",
            body: file.buffer,
            quality: 100,
            width: 1200,
        });

        return result;
    }

    /**
     * Send document review notification email
     */
    async sendReviewNotification(
        userId: number,
        documentType: DocumentType,
        approved: boolean,
        rejectionReason?: string
    ): Promise<void> {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { email: true, firstName: true },
        });

        if (!user?.email) {
            this.logger.warn(`Cannot send notification: user ${userId} has no email`);
            return;
        }

        const templateKey = approved
            ? emailTemplateConfig.document_approved
            : emailTemplateConfig.document_rejected;

        if (!templateKey) {
            this.logger.warn(`Email template not configured for document ${approved ? "approval" : "rejection"}`);
            return;
        }

        const documentTypeFriendlyMap: Record<string, string> = {
            address: "Address",
            income: "Income",
            business: "Business Documents",
        };
        const documentTypeFriendly = documentTypeFriendlyMap[documentType] || documentType;

        try {
            await this.emailService.sendMailWithTemplate({
                from: { address: mailConfig.senderMail },
                to: [{ email_address: { address: user.email } }],
                template_key: templateKey,
                merge_info: {
                    first_name: user.firstName || "User",
                    document_type: documentTypeFriendly,
                    company_name: COMPANY_NAME,
                    rejection_reason: rejectionReason || "",
                    status: approved ? "Approved" : "Rejected",
                },
            });

            this.logger.log(
                `Review notification sent to ${user.email} for ${documentType} document - ${approved ? "approved" : "rejected"}`
            );
        } catch (error) {
            this.logger.error(
                `Failed to send review notification to ${user.email}: ${error.message}`
            );
        }
    }

    /**
     * Approve document verification (called by admin)
     */
    async approveDocument(
        userId: number,
        documentType: "address" | "income" | "business"
    ): Promise<ApiResponse> {
        const updateData: Record<string, unknown> = {};

        if (documentType === "address") {
            updateData.addressVerificationStatus = DocumentVerificationStatus.VERIFIED;
            updateData.isAddressVerified = true;
        } else if (documentType === "business") {
            updateData.businessDocumentVerificationStatus = DocumentVerificationStatus.VERIFIED;
            updateData.isDocumentVerified = true;
        } else {
            updateData.incomeVerificationStatus = DocumentVerificationStatus.VERIFIED;
            updateData.isIncomeVerified = true;
        }

        await this.prisma.user.update({
            where: { id: userId },
            data: updateData,
        });

        // Sync tier & flush cache
        await this.tierService.syncTierAndCache(userId);

        // Send email notification
        await this.sendReviewNotification(userId, documentType, true);

        // In-app notification + push
        const friendlyMap: Record<string, string> = {
            address: "Address",
            income: "Income",
            business: "Business Documents",
        };
        const friendlyType = friendlyMap[documentType] || documentType;
        await this.notificationDispatcher.notify({
            userId,
            title: "Document Approved",
            body: `Your ${friendlyType} verification has been approved.`,
            category: "security",
            enablePush: true,
        });

        // Push real-time profile update to connected client
        this.wsGateway.notifyProfileUpdate(userId);

        this.logger.log(`Admin approved ${documentType} document for user ${userId}`);

        return buildResponse({
            message: `${friendlyType} approved successfully`,
        });
    }

    /**
     * Reject document verification (called by admin)
     */
    async rejectDocument(
        userId: number,
        documentType: "address" | "income" | "business",
        reason: string
    ): Promise<ApiResponse> {
        const updateData: Record<string, unknown> = {};

        if (documentType === "address") {
            updateData.addressVerificationStatus = DocumentVerificationStatus.DECLINED;
            updateData.isAddressVerified = false;
            updateData.addressDocumentUrl = null;
        } else if (documentType === "business") {
            updateData.businessDocumentVerificationStatus = DocumentVerificationStatus.DECLINED;
            updateData.businessDocumentsUploaded = false;
        } else {
            updateData.incomeVerificationStatus = DocumentVerificationStatus.DECLINED;
            updateData.isIncomeVerified = false;
            updateData.incomeDocumentUrl = null;
        }

        await this.prisma.user.update({
            where: { id: userId },
            data: updateData,
        });

        // Sync tier & flush cache (rejection may lower tier)
        await this.tierService.syncTierAndCache(userId);

        // Send email notification
        await this.sendReviewNotification(userId, documentType, false, reason);

        // In-app notification + push
        const friendlyMap: Record<string, string> = {
            address: "Address",
            income: "Income",
            business: "Business Documents",
        };
        const friendlyType = friendlyMap[documentType] || documentType;
        await this.notificationDispatcher.notify({
            userId,
            title: "Document Rejected",
            body: `Your ${friendlyType} verification was rejected. Reason: ${reason}`,
            category: "security",
            enablePush: true,
        });

        // Push real-time profile update to connected client
        this.wsGateway.notifyProfileUpdate(userId);

        this.logger.log(`Admin rejected ${documentType} document for user ${userId}: ${reason}`);

        return buildResponse({
            message: `${friendlyType} rejected`,
        });
    }
}
