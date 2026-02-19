import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Logger,
    Post,
    Req,
    UploadedFile,
    UploadedFiles,
    UseGuards,
    UseInterceptors,
    ValidationPipe,
} from "@nestjs/common";
import { RateLimiterGuard, StrictRateLimit, RateLimit } from "@/modules/core/rate-limit/guards/rate-limiter.guard";
import { Request } from "express";
import {
    BvnVerificationDto,
    NinVerificationDto,
    CreatePasswordDto,
    DocumentVerificationDto,
    OnboardIndividualDto,
    SendEmailVerificationCodeDto,
    SendPhoneVerificationCodeDto,
    SignUpDto,
    UserSigInDto,
    SubmitBusinessRecordDto,
    VerifyEmailOtpDto,
    VerifyPhoneOtpDto,
    SendForgotPasswordDto,
    ResetPasswordDto,
    RefreshTokenDto,
    BusinessDocumentUploadDto,
    BusinessDocumentUploadFormDto,
    UploadBusinessDocumentFileDto,
    UploadBusinessDocumentFileFormDto,
    SubmitBusinessDocumentsDto,
    DocumentVerificationUploadFormDto,
    DocumentVerificationBase64Dto,
    DocumentPreviewDto,
    DojahWidgetVerificationDto,
    Verify2FALoginDto,
    VerifyAddressUploadFormDto,
    VerifyIncomeUploadFormDto,
    CreateTradingPasswordDto,
    DojahVerifyAddressDto,
    DojahVerifyIncomeDto,
    DojahVerifyGovernmentIdDto,
} from "../../dtos";

import { AuthService } from "../../services";
import { TierVerificationService } from "../../services/tier-verification.service";
import {
    ApiTags,
    ApiOperation,
    ApiBearerAuth,
    ApiConsumes,
    ApiBody,
} from "@nestjs/swagger";
import { AuthGuard, CountryBlockGuard } from "../../guard";
import { User } from "@/modules/api/user";
import { DocumentType, User as UserModel, UserType } from "@prisma/client";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { UserTypes } from "@/modules/api/authorize/decorator";
import {
    FileFieldsInterceptor,
    FileInterceptor,
} from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { RequiredFilesMissing } from "../../errors";
import {
    DocumentVerificationFileInterface,
    UploadBusinessDocumentsFileInterface,
} from "../../interfaces";

@UseGuards(CountryBlockGuard)
@ApiTags("auth")
@Controller({
    path: "auth",
})
export class AuthController {
    private readonly logger = new Logger(AuthController.name);

    constructor(
        private authService: AuthService,
        private tierVerificationService: TierVerificationService
    ) { }

    @UseGuards(RateLimiterGuard)
    @StrictRateLimit()
    @Post("signup")
    @ApiOperation({ summary: "individual and business signup" })
    async signUp(
        @Body(ValidationPipe) signUpDto: SignUpDto,
        @Req() req: Request
    ) {
        return await this.authService.signUp(signUpDto, req.ip);
    }

    @UseGuards(RateLimiterGuard)
    @StrictRateLimit()
    @HttpCode(HttpStatus.OK)
    @Post("login")
    @ApiOperation({ summary: "user login" })
    async signIn(
        @Body(ValidationPipe) signInDto: UserSigInDto,
        @Req() req: Request
    ) {
        return await this.authService.userSignIn(signInDto, req.ip);
    }

    @UseGuards(RateLimiterGuard)
    @StrictRateLimit()
    @HttpCode(HttpStatus.OK)
    @Post("verify-2fa-login")
    @ApiOperation({ summary: "verify 2FA code to complete login" })
    async verify2FALogin(
        @Body(ValidationPipe) dto: Verify2FALoginDto,
        @Req() req: Request
    ) {
        return await this.authService.verify2FALogin(dto, req.ip);
    }

    @UseGuards(RateLimiterGuard)
    @StrictRateLimit()
    @HttpCode(HttpStatus.OK)
    @Post("initiate-email-verification")
    @ApiOperation({ summary: "initiate email verification process" })
    async sendAccountVerificationEmail(
        @Body(ValidationPipe)
        sendVerificationCodeDto: SendEmailVerificationCodeDto
    ) {
        return await this.authService.sendAccountVerificationEmail(
            sendVerificationCodeDto
        );
    }

    @UseGuards(RateLimiterGuard)
    @StrictRateLimit()
    @HttpCode(HttpStatus.OK)
    @Post("verify-email-otp")
    @ApiOperation({ summary: "verify email verification otp" })
    async verifyEmailOtp(
        @Body(ValidationPipe) verifyEmailOtpDto: VerifyEmailOtpDto
    ) {
        return await this.authService.verifyEmailOtp(verifyEmailOtpDto);
    }

    @UseGuards(AuthGuard)
    @HttpCode(HttpStatus.OK)
    @Post("create-password")
    @ApiOperation({ summary: "create user password" })
    @ApiBearerAuth("access-token")
    async createPassword(
        @User() user: UserModel,
        @Body(ValidationPipe) createPasswordDto: CreatePasswordDto
    ) {
        return await this.authService.createPassword(user, createPasswordDto);
    }

    @ApiBearerAuth("access-token")
    @UseGuards(AuthGuard)
    @HttpCode(HttpStatus.OK)
    @Post("onboard-individual")
    @ApiOperation({ summary: "onboard user with individual account - save basic profile info" })
    async onboardIndividual(
        @User() user: UserModel,
        @Body(ValidationPipe) dto: OnboardIndividualDto
    ) {
        return await this.authService.onboardIndividual(user, dto);
    }

    @ApiBearerAuth("access-token")
    @UseGuards(RateLimiterGuard, AuthGuard)
    @StrictRateLimit()
    @HttpCode(HttpStatus.OK)
    @Post("verify-bvn")
    @ApiOperation({ summary: "verify user with individual account bvn" })
    @ApiBearerAuth("access-token")
    async bvnVerification(
        @User() user: UserModel,
        @Body(ValidationPipe) dto: BvnVerificationDto
    ) {
        return await this.authService.bvnVerification(user, dto);
    }

    @ApiBearerAuth("access-token")
    @UseGuards(RateLimiterGuard, AuthGuard)
    @StrictRateLimit()
    @HttpCode(HttpStatus.OK)
    @Post("verify-nin")
    @ApiOperation({ summary: "verify user with individual account NIN" })
    async ninVerification(
        @User() user: UserModel,
        @Body(ValidationPipe) dto: NinVerificationDto
    ) {
        return await this.authService.ninVerification(user, dto);
    }

    @UseGuards(RateLimiterGuard, AuthGuard)
    @StrictRateLimit()
    @HttpCode(HttpStatus.OK)
    @Post("initiate-phone-verification")
    @ApiOperation({ summary: "initiate phone verification process" })
    @ApiBearerAuth("access-token")
    async sendPhoneVerificationOtp(
        @User() user: UserModel,
        @Body(ValidationPipe) dto: SendPhoneVerificationCodeDto
    ) {
        return await this.authService.sendPhoneVerificationOtp(user, dto);
    }

    @UseGuards(RateLimiterGuard, AuthGuard)
    @StrictRateLimit()
    @HttpCode(HttpStatus.OK)
    @Post("verify-phone-otp")
    @ApiOperation({ summary: "verify phone verification otp" })
    @ApiBearerAuth("access-token")
    async verifyPhoneOtp(
        @User() user: UserModel,
        @Body(ValidationPipe) verifyPhoneOtpDto: VerifyPhoneOtpDto
    ) {
        return await this.authService.verifyPhoneOtp(user, verifyPhoneOtpDto);
    }

    @UseGuards(RateLimiterGuard, AuthGuard)
    @StrictRateLimit()
    @HttpCode(HttpStatus.OK)
    @Post("verify-document")
    @ApiOperation({
        summary: "document verification for users with individual account type",
    })
    @ApiConsumes("multipart/form-data")
    @ApiBody({
        type: DocumentVerificationUploadFormDto,
        description:
            "document upload and verification for users with individual account type",
    })
    @ApiBearerAuth("access-token")
    @UseInterceptors(
        FileFieldsInterceptor(
            [
                { name: "documentImage1", maxCount: 1 },
                { name: "documentImage2", maxCount: 1 },
            ],
            {
                storage: memoryStorage(),
                limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit per file
            }
        )
    )
    async documentVerification(
        @User() user: UserModel,
        @UploadedFiles()
        files: DocumentVerificationFileInterface,
        @Body(ValidationPipe) dto: DocumentVerificationDto
    ) {
        if (
            !files.documentImage1 ||
            (dto.documentType === DocumentType.INTERNATIONAL_PASSPORT &&
                !files.documentImage2)
        ) {
            throw new RequiredFilesMissing();
        }
        return await this.authService.documentVerification(user, files, dto);
    }

    /**
     * Document verification endpoint optimized for Dojah integration
     * Accepts base64-encoded images directly in JSON body
     * No FormData/multipart needed - simpler client integration
     */
    @UseGuards(RateLimiterGuard, AuthGuard)
    @StrictRateLimit()
    @HttpCode(HttpStatus.OK)
    @Post("verify-document-base64")
    @ApiOperation({
        summary: "Document verification with base64-encoded images (Dojah-optimized)",
        description: "Upload document images as base64 strings. Removes data:image prefix before sending. Simpler than multipart/form-data.",
    })
    @ApiBearerAuth("access-token")
    async documentVerificationBase64(
        @User() user: UserModel,
        @Body(ValidationPipe) dto: DocumentVerificationBase64Dto
    ) {
        // Validate that front image is provided
        if (!dto.imageFrontBase64) {
            throw new RequiredFilesMissing();
        }
        // For passports, require back image
        if (
            dto.documentType === DocumentType.INTERNATIONAL_PASSPORT &&
            !dto.imageBackBase64
        ) {
            throw new RequiredFilesMissing();
        }
        return await this.authService.documentVerificationBase64(user, dto);
    }

    /**
     * Preview/pre-validate document using Dojah OCR
     * Does NOT save to database - just returns extracted data for user verification
     */
    @UseGuards(AuthGuard)
    @HttpCode(HttpStatus.OK)
    @Post("preview-document")
    @ApiOperation({
        summary: "Preview document using Dojah OCR (no database save)",
        description: "Analyzes document images and returns extracted data for user verification before final submission. Does not save anything to database.",
    })
    @ApiBearerAuth("access-token")
    async previewDocument(
        @User() user: UserModel,
        @Body(ValidationPipe) dto: DocumentPreviewDto
    ) {
        if (!dto.imageFrontBase64) {
            throw new RequiredFilesMissing();
        }
        return await this.authService.previewDocument(user, dto);
    }

    /**
     * Submit Dojah Widget verification result
     * Saves verified document data from Dojah Widget to database
     */
    @UseGuards(RateLimiterGuard, AuthGuard)
    @StrictRateLimit()
    @HttpCode(HttpStatus.OK)
    @Post("submit-dojah-verification")
    @ApiOperation({
        summary: "Submit Dojah Widget verification result",
        description: "Receives verification data from Dojah Widget and saves the verification record to the database.",
    })
    @ApiBearerAuth("access-token")
    async submitDojahVerification(
        @User() user: UserModel,
        @Body(ValidationPipe) dto: DojahWidgetVerificationDto
    ) {
        this.logger.log(
            `[DojahRoute] submit-dojah-verification hit: userId=${user.id}, hasVerificationId=${!!dto.verificationId}, hasReferenceId=${!!dto.referenceId}, hasIdData=${!!dto.idData}`
        );
        return await this.authService.submitDojahWidgetVerification(user, dto);
    }

    @UseGuards(AuthGuard)
    @HttpCode(HttpStatus.OK)
    @Post("submit-business-record")
    @ApiOperation({
        summary: "submit business record for users with business account type",
    })
    @ApiBearerAuth("access-token")
    async submitBusinessRecord(
        @User() user: UserModel,
        @Body(ValidationPipe) dto: SubmitBusinessRecordDto
    ) {
        return await this.authService.submitBusinessRecord(user, dto);
    }

    @UseGuards(AuthGuard, RoleGuard)
    @UserTypes([UserType.BUSINESS])
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: "upload requested business documents",
    })
    @ApiConsumes("multipart/form-data")
    @ApiBody({
        type: BusinessDocumentUploadFormDto,
        description: "Business document upload",
    })
    @ApiBearerAuth("access-token")
    @Post("upload-business-documents")
    @UseInterceptors(
        FileFieldsInterceptor(
            [
                { name: "cacImage", maxCount: 1 },
                { name: "articleOfAssociationImage", maxCount: 1 },
                {
                    name: "boardResolutionAuthorizedAcctOpeningImage",
                    maxCount: 1,
                },
                { name: "proofOfAddressForBeneficialOwner", maxCount: 1 },
                {
                    name: "meansOfIdentificationForBeneficialOwner",
                    maxCount: 1,
                },
            ],
            {
                storage: memoryStorage(),
                limits: { fileSize: 20 * 1024 * 1024 }, // 20MB limit per file
            }
        )
    )
    async updloadBusinessDocuments(
        @User() user: UserModel,
        @UploadedFiles()
        files: UploadBusinessDocumentsFileInterface,
        @Body(ValidationPipe) body: BusinessDocumentUploadDto
    ) {
        if (!files?.cacImage?.length || !files.cacImage[0]) {
            throw new RequiredFilesMissing();
        }

        return await this.authService.updloadBusinessDocuments(
            user,
            files,
            body
        );
    }

    /**
     * Upload a single business document file (sequential upload flow).
     * Each file is uploaded individually to avoid Vercel's 4.5MB body limit.
     */
    @UseGuards(AuthGuard, RoleGuard)
    @UserTypes([UserType.BUSINESS])
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: "upload a single business document file",
    })
    @ApiConsumes("multipart/form-data")
    @ApiBody({
        type: UploadBusinessDocumentFileFormDto,
        description: "Single business document file upload",
    })
    @ApiBearerAuth("access-token")
    @Post("upload-business-document-file")
    @UseInterceptors(
        FileInterceptor("file", {
            storage: memoryStorage(),
            limits: { fileSize: 20 * 1024 * 1024 },
        })
    )
    async uploadBusinessDocumentFile(
        @User() user: UserModel,
        @UploadedFile() file: Express.Multer.File,
        @Body(ValidationPipe) body: UploadBusinessDocumentFileDto
    ) {
        if (!file) {
            throw new RequiredFilesMissing();
        }

        return await this.authService.uploadSingleBusinessDocumentFile(
            user,
            file,
            body
        );
    }

    /**
     * Submit all previously-uploaded business document URLs.
     * Called after all individual files have been uploaded via upload-business-document-file.
     */
    @UseGuards(AuthGuard, RoleGuard)
    @UserTypes([UserType.BUSINESS])
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: "submit business documents (URLs from sequential uploads)",
    })
    @ApiBearerAuth("access-token")
    @Post("submit-business-documents")
    async submitBusinessDocuments(
        @User() user: UserModel,
        @Body(ValidationPipe) body: SubmitBusinessDocumentsDto
    ) {
        return await this.authService.submitBusinessDocumentsFromUrls(
            user,
            body
        );
    }

    @UseGuards(RateLimiterGuard)
    @StrictRateLimit()
    @HttpCode(HttpStatus.OK)
    @Post("forgot-password")
    @ApiOperation({ summary: "request password reset" })
    async forgotPassword(@Body(ValidationPipe) dto: SendForgotPasswordDto) {
        return await this.authService.requestPasswordReset(dto);
    }

    @UseGuards(RateLimiterGuard)
    @StrictRateLimit()
    @HttpCode(HttpStatus.OK)
    @Post("reset-password")
    @ApiOperation({ summary: "reset password" })
    async resetPassword(@Body(ValidationPipe) dto: ResetPasswordDto) {
        return await this.authService.resetPassword(dto);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "refresh user access token" })
    @Post("refresh-token")
    async refreshToken(
        @Body(ValidationPipe) refreshTokenDto: RefreshTokenDto
    ): Promise<ApiResponse> {
        return await this.authService.refreshToken(refreshTokenDto);
    }

    // ==================== Tier 2/3 Verification Endpoints ====================

    @UseGuards(RateLimiterGuard, AuthGuard)
    @RateLimit({ limit: 5, windowSeconds: 3600 })
    @HttpCode(HttpStatus.OK)
    @Post("verify-address")
    @ApiOperation({ summary: "Upload proof of address for Tier 2 verification" })
    @ApiConsumes("multipart/form-data")
    @ApiBody({
        type: VerifyAddressUploadFormDto,
        description: "Address proof document (utility bill, bank statement)",
    })
    @ApiBearerAuth("access-token")
    @UseInterceptors(
        FileInterceptor("document", {
            storage: memoryStorage(),
            limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
        })
    )
    async verifyAddress(
        @User() user: UserModel,
        @UploadedFile() file: Express.Multer.File
    ) {
        if (!file) {
            throw new RequiredFilesMissing();
        }
        return await this.tierVerificationService.verifyAddress(user, file);
    }

    @UseGuards(RateLimiterGuard, AuthGuard)
    @RateLimit({ limit: 5, windowSeconds: 3600 })
    @HttpCode(HttpStatus.OK)
    @Post("verify-income")
    @ApiOperation({ summary: "Upload proof of income for Tier 3 verification" })
    @ApiConsumes("multipart/form-data")
    @ApiBody({
        type: VerifyIncomeUploadFormDto,
        description: "Income proof document (payslip, bank statement, tax document)",
    })
    @ApiBearerAuth("access-token")
    @UseInterceptors(
        FileInterceptor("document", {
            storage: memoryStorage(),
            limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
        })
    )
    async verifyIncome(
        @User() user: UserModel,
        @UploadedFile() file: Express.Multer.File
    ) {
        if (!file) {
            throw new RequiredFilesMissing();
        }
        return await this.tierVerificationService.verifyIncome(user, file);
    }

    // ==================== Dojah Widget Verification Endpoints ====================

    @UseGuards(RateLimiterGuard, AuthGuard)
    @RateLimit({ limit: 5, windowSeconds: 3600 })
    @HttpCode(HttpStatus.OK)
    @Post("verify-address/dojah")
    @ApiOperation({ summary: "Verify address using Dojah widget verification data" })
    @ApiBearerAuth("access-token")
    async verifyAddressWithDojah(
        @User() user: UserModel,
        @Body(ValidationPipe) dto: DojahVerifyAddressDto
    ) {
        return await this.tierVerificationService.verifyAddressWithDojah(user, dto);
    }

    @UseGuards(RateLimiterGuard, AuthGuard)
    @RateLimit({ limit: 5, windowSeconds: 3600 })
    @HttpCode(HttpStatus.OK)
    @Post("verify-income/dojah")
    @ApiOperation({ summary: "Verify income using Dojah widget verification data" })
    @ApiBearerAuth("access-token")
    async verifyIncomeWithDojah(
        @User() user: UserModel,
        @Body(ValidationPipe) dto: DojahVerifyIncomeDto
    ) {
        return await this.tierVerificationService.verifyIncomeWithDojah(user, dto);
    }

    @UseGuards(RateLimiterGuard, AuthGuard)
    @RateLimit({ limit: 5, windowSeconds: 3600 })
    @HttpCode(HttpStatus.OK)
    @Post("verify-government-id/dojah")
    @ApiOperation({ summary: "Verify BVN/NIN using Dojah widget verification data" })
    @ApiBearerAuth("access-token")
    async verifyGovernmentIdWithDojah(
        @User() user: UserModel,
        @Body(ValidationPipe) dto: DojahVerifyGovernmentIdDto
    ) {
        this.logger.log(
            `[DojahRoute] verify-government-id/dojah hit: userId=${user.id}, hasVerificationId=${!!dto.verificationId}, verificationType=${dto.verificationType || "N/A"}, hasGovernment=${!!dto.government}`
        );
        return await this.tierVerificationService.verifyGovernmentIdWithDojah(user, dto);
    }

    @UseGuards(AuthGuard)
    @HttpCode(HttpStatus.OK)
    @Post("create-trading-password")
    @ApiOperation({ summary: "Create or update trading password" })
    @ApiBearerAuth("access-token")
    async createTradingPassword(
        @User() user: UserModel,
        @Body(ValidationPipe) dto: CreateTradingPasswordDto
    ) {
        return await this.tierVerificationService.createTradingPassword(user, dto);
    }

    @UseGuards(AuthGuard)
    @HttpCode(HttpStatus.OK)
    @Get("trading-password-status")
    @ApiOperation({ summary: "Check if user has trading password set" })
    @ApiBearerAuth("access-token")
    async hasTradingPassword(@User() user: UserModel) {
        return await this.tierVerificationService.hasTradingPassword(user);
    }

    @UseGuards(AuthGuard)
    @HttpCode(HttpStatus.OK)
    @Get("verification-status")
    @ApiOperation({ summary: "Get tier verification status" })
    @ApiBearerAuth("access-token")
    async getVerificationStatus(@User() user: UserModel) {
        return await this.tierVerificationService.getVerificationStatus(user);
    }


}
