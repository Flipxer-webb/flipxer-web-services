import {
    Body,
    Controller,
    HttpCode,
    HttpStatus,
    Post,
    Req,
    UploadedFiles,
    UseGuards,
    UseInterceptors,
    ValidationPipe,
} from "@nestjs/common";
import { Request } from "express";
import {
    BvnVerificationDto,
    CreatePasswordDto,
    DocumentVerificationDto,
    SendEmailVerificationCodeDto,
    SendPhoneVerificationCodeDto,
    SignUpDto,
    SubmitBusinessRecordDto,
    UserSigInDto,
    VerifyEmailOtpDto,
    VerifyPhoneOtpDto,
    SendForgotPasswordDto,
    ResetPasswordDto,
    RefreshTokenDto,
    BusinessDocumentUploadDto,
    BusinessDocumentUploadFormDto,
    DocumentVerificationUploadFormDto,
} from "../../dtos";
import { AuthService } from "../../services";
import {
    ApiTags,
    ApiOperation,
    ApiBearerAuth,
    ApiConsumes,
    ApiBody,
} from "@nestjs/swagger";
import { AuthGuard } from "../../guard";
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

@ApiTags("user")
@Controller({
    path: "auth",
})
export class AuthController {
    constructor(private authService: AuthService) {}

    @Post("signup")
    @ApiOperation({ summary: "individual and business signup" })
    async signUp(
        @Body(ValidationPipe) signUpDto: SignUpDto,
        @Req() req: Request
    ) {
        return await this.authService.signUp(signUpDto, req.ip);
    }

    @HttpCode(HttpStatus.OK)
    @Post("login")
    @ApiOperation({ summary: "user login" })
    async signIn(
        @Body(ValidationPipe) signInDto: UserSigInDto,
        @Req() req: Request
    ) {
        return await this.authService.userSignIn(signInDto, req.ip);
    }

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
    @Post("verify-bvn")
    @ApiOperation({ summary: "verify user with individual account bvn" })
    @ApiBearerAuth("access-token")
    async bvnVerification(
        @User() user: UserModel,
        @Body(ValidationPipe) dto: BvnVerificationDto
    ) {
        return await this.authService.bvnVerification(user, dto);
    }

    @UseGuards(AuthGuard)
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

    @UseGuards(AuthGuard)
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

    @UseGuards(AuthGuard)
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
        @Body() body: BusinessDocumentUploadDto
    ) {
        if (
            !files.cacImage ||
            !files.boardResolutionAuthorizedAcctOpeningImage ||
            !files.articleOfAssociationImage ||
            !files.proofOfAddressForBeneficialOwner ||
            !files.meansOfIdentificationForBeneficialOwner
        ) {
            throw new RequiredFilesMissing();
        }

        return await this.authService.updloadBusinessDocuments(
            user,
            files,
            body
        );
    }

    @HttpCode(HttpStatus.OK)
    @Post("forgot-password")
    @ApiOperation({ summary: "request password reset" })
    async forgotPassword(@Body(ValidationPipe) dto: SendForgotPasswordDto) {
        return await this.authService.requestPasswordReset(dto);
    }

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
}
