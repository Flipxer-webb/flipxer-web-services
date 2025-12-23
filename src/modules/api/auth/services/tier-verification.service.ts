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
    DojahVerifyAddressDto,
    DojahVerifyIncomeDto,
    DojahVerifyGovernmentIdDto,
} from "../dtos";
import { TierService } from "./tier.service";
import * as bcrypt from "bcryptjs";

@Injectable()
export class TierVerificationService {
    private readonly logger = new Logger(TierVerificationService.name);
    private uploadService: ImagekitService | CloudinaryService;
    private readonly SALT_ROUNDS = 10;

    constructor(
        private readonly prisma: PrismaService,
        private readonly uploadFactory: UploadFactory,
        private readonly tierService: TierService,
        private readonly emailService: EmailService
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

            return buildResponse({
                message:
                    "Document uploaded successfully. It will be reviewed by our team.",
                data: {
                    status: "pending_review",
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

        // Update tier
        await this.tierService.updateUserTier(user.id);

        return buildResponse({
            message: "Address verified successfully",
            data: {
                status: "verified",
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

            return buildResponse({
                message:
                    "Document uploaded successfully. It will be reviewed by our team.",
                data: {
                    status: "pending_review",
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

        // Update tier
        await this.tierService.updateUserTier(user.id);

        return buildResponse({
            message: "Income verified successfully",
            data: {
                status: "verified",
            },
        });
    }

    // ==================== Dojah Widget Verification Methods ====================

    /**
     * Verify address using Dojah widget verification data
     * This is an alternative to file upload, using Dojah's address verification widget
     */
    async verifyAddressWithDojah(
        user: User,
        dto: DojahVerifyAddressDto
    ): Promise<ApiResponse> {
        // Check if already verified
        if (user.isAddressVerified) {
            return buildResponse({
                message: "Address is already verified",
            });
        }

        this.logger.log(
            `Processing Dojah address verification for user ${user.id}, verificationId: ${dto.verificationId}`
        );

        // Store verification data and mark as verified
        // Dojah widget verification is considered auto-approved since verification
        // happens within the Dojah widget itself
        const addressString = dto.address
            ? [
                  dto.address.street,
                  dto.address.city,
                  dto.address.lga,
                  dto.address.state,
                  dto.address.country,
                  dto.address.postalCode,
              ]
                  .filter(Boolean)
                  .join(", ") || dto.address.fullAddress
            : null;

        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                // Store address string in addressDocumentUrl as a reference
                addressDocumentUrl: addressString || user.addressDocumentUrl,
                addressVerificationStatus: DocumentVerificationStatus.VERIFIED,
                isAddressVerified: true,
            },
        });

        // Update tier
        await this.tierService.updateUserTier(user.id);

        this.logger.log(
            `Address verified via Dojah widget for user ${user.id}`
        );

        return buildResponse({
            message: "Address verified successfully",
            data: {
                status: "verified",
                isAddressVerified: true,
            },
        });
    }

    /**
     * Verify income/source of funds using Dojah widget verification data
     * This is an alternative to file upload, using Dojah's document upload widget
     */
    async verifyIncomeWithDojah(
        user: User,
        dto: DojahVerifyIncomeDto
    ): Promise<ApiResponse> {
        // Check if already verified
        if (user.isIncomeVerified) {
            return buildResponse({
                message: "Income is already verified",
            });
        }

        this.logger.log(
            `Processing Dojah income verification for user ${user.id}, verificationId: ${dto.verificationId}`
        );

        // Store verification data
        // For income/document verification via Dojah, we may want manual review
        // since document content verification happens differently
        const documentUrl = dto.document?.documentUrl || null;

        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                incomeDocumentUrl: documentUrl,
                incomeVerificationStatus: DocumentVerificationStatus.VERIFIED,
                isIncomeVerified: true,
            },
        });

        // Update tier
        await this.tierService.updateUserTier(user.id);

        this.logger.log(
            `Income verified via Dojah widget for user ${user.id}`
        );

        return buildResponse({
            message: "Income verified successfully",
            data: {
                status: "verified",
                isIncomeVerified: true,
            },
        });
    }

    /**
     * Verify government ID (BVN/NIN) using Dojah widget verification data
     * This is an alternative to manual BVN/NIN entry, using Dojah's government data widget
     */
    async verifyGovernmentIdWithDojah(
        user: User,
        dto: DojahVerifyGovernmentIdDto
    ): Promise<ApiResponse> {
        const govData = dto.government;
        const idType = govData?.idType?.toLowerCase() || "unknown";

        this.logger.log(
            `Processing Dojah government ID verification for user ${user.id}, type: ${idType}, verificationId: ${dto.verificationId}`
        );

        // Check if already verified based on ID type
        if (idType === "bvn" && user.isBvnVerified) {
            return buildResponse({
                message: "BVN is already verified",
            });
        }

        if (idType === "nin" && user.isNinVerified) {
            return buildResponse({
                message: "NIN is already verified",
            });
        }

        // Prepare user data update based on government data
        const updateData: Record<string, unknown> = {};

        // Update user's name and DOB from government data if available
        if (govData?.firstName) {
            updateData.firstName = govData.firstName;
        }
        if (govData?.lastName) {
            updateData.lastName = govData.lastName;
        }
        if (govData?.dateOfBirth) {
            updateData.dateOfBirth = new Date(govData.dateOfBirth);
        }

        // Set verification status based on ID type
        if (idType === "bvn") {
            updateData.isBvnVerified = true;
            updateData.bvn = govData?.idNumber;
            if (govData?.phoneNumber) {
                updateData.bvnRegisteredPhone = govData.phoneNumber;
            }
        } else if (idType === "nin") {
            updateData.isNinVerified = true;
            updateData.nin = govData?.idNumber;
            if (govData?.phoneNumber) {
                updateData.ninRegisteredPhone = govData.phoneNumber;
            }
        } else {
            // For other government IDs (voters_id, drivers_license, etc.)
            // Treat as document verification
            updateData.isDocumentVerified = true;
        }

        await this.prisma.user.update({
            where: { id: user.id },
            data: updateData,
        });

        // Update tier
        await this.tierService.updateUserTier(user.id);

        this.logger.log(
            `Government ID (${idType}) verified via Dojah widget for user ${user.id}`
        );

        return buildResponse({
            message: `${idType.toUpperCase()} verified successfully`,
            data: {
                status: "verified",
                idType,
                isBvnVerified: idType === "bvn",
                isNinVerified: idType === "nin",
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
        documentType: "address" | "income",
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

        const documentTypeFriendly = documentType === "address" ? "Address" : "Income";

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
        documentType: "address" | "income"
    ): Promise<ApiResponse> {
        const updateData: Record<string, unknown> = {};

        if (documentType === "address") {
            updateData.addressVerificationStatus = DocumentVerificationStatus.VERIFIED;
            updateData.isAddressVerified = true;
        } else {
            updateData.incomeVerificationStatus = DocumentVerificationStatus.VERIFIED;
            updateData.isIncomeVerified = true;
        }

        await this.prisma.user.update({
            where: { id: userId },
            data: updateData,
        });

        // Update tier
        await this.tierService.updateUserTier(userId);

        // Send notification
        await this.sendReviewNotification(userId, documentType, true);

        this.logger.log(`Admin approved ${documentType} document for user ${userId}`);

        return buildResponse({
            message: `${documentType === "address" ? "Address" : "Income"} document approved successfully`,
        });
    }

    /**
     * Reject document verification (called by admin)
     */
    async rejectDocument(
        userId: number,
        documentType: "address" | "income",
        reason: string
    ): Promise<ApiResponse> {
        const updateData: Record<string, unknown> = {};

        if (documentType === "address") {
            updateData.addressVerificationStatus = DocumentVerificationStatus.DECLINED;
            updateData.isAddressVerified = false;
            updateData.addressDocumentUrl = null;
        } else {
            updateData.incomeVerificationStatus = DocumentVerificationStatus.DECLINED;
            updateData.isIncomeVerified = false;
            updateData.incomeDocumentUrl = null;
        }

        await this.prisma.user.update({
            where: { id: userId },
            data: updateData,
        });

        // Send notification
        await this.sendReviewNotification(userId, documentType, false, reason);

        this.logger.log(`Admin rejected ${documentType} document for user ${userId}: ${reason}`);

        return buildResponse({
            message: `${documentType === "address" ? "Address" : "Income"} document rejected`,
        });
    }
}
