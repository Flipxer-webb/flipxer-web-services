import { ApiResponse } from "@/utils/api-response-util";
import {
    Body,
    Controller,
    HttpCode,
    HttpStatus,
    Post,
    Req,
    UseGuards,
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
} from "../../dtos";
import { AuthService } from "../../services";
import { AuthGuard } from "../../guard";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { User } from "@/modules/api/user";
import { User as UserModel } from "@prisma/client";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

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
    ): Promise<ApiResponse> {
        return await this.authService.signUp(signUpDto, req.ip);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "initiate email verification process" })
    @Post("initiate-email-verification")
    async sendAccountVerificationEmail(
        @Body(ValidationPipe)
        sendVerificationCodeDto: SendEmailVerificationCodeDto
    ) {
        return await this.authService.sendAccountVerificationEmail(
            sendVerificationCodeDto
        );
    }

    @HttpCode(HttpStatus.OK)
    @Post("/verify-email-otp")
    @ApiOperation({ summary: "verify email verification otp" })
    async verifyEmailOtp(
        @Body(ValidationPipe) verifyEmailOtpDto: VerifyEmailOtpDto
    ) {
        return await this.authService.verifyEmailOtp(verifyEmailOtpDto);
    }

    @UseGuards(AuthGuard)
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "create use password" })
    @ApiBearerAuth("access-token")
    @Post("/create-password")
    async createPassword(
        @User() user: UserModel,
        @Body(ValidationPipe) createPasswordDto: CreatePasswordDto
    ) {
        return await this.authService.createPassword(user, createPasswordDto);
    }

    @UseGuards(AuthGuard)
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "verify user with individual account bvn" })
    @ApiBearerAuth("access-token")
    @Post("/verify-bvn")
    async bvnVerification(
        @User() user: UserModel,
        @Body(ValidationPipe) dto: BvnVerificationDto
    ) {
        return await this.authService.bvnVerification(user, dto);
    }

    @UseGuards(AuthGuard)
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "initiate phone verification process" })
    @ApiBearerAuth("access-token")
    @Post("initiate-phone-verification")
    async sendPhoneVerificationOtp(
        @User() user: UserModel,
        @Body(ValidationPipe)
        dto: SendPhoneVerificationCodeDto
    ) {
        return await this.authService.sendPhoneVerificationOtp(user, dto);
    }

    @UseGuards(AuthGuard)
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "verify phone verification otp" })
    @Post("/verify-phone-otp")
    async verifyPhoneOtp(
        @User() user: UserModel,
        @Body(ValidationPipe) verifyPhoneOtpDto: VerifyPhoneOtpDto
    ) {
        return await this.authService.verifyPhoneOtp(user, verifyPhoneOtpDto);
    }

    @UseGuards(AuthGuard)
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: "dcoument verification for users with individual account type",
    })
    @Post("/verify-document")
    async documentVerification(
        @User() user: UserModel,
        @Body(ValidationPipe) dto: DocumentVerificationDto
    ) {
        return await this.authService.documentVerification(user, dto);
    }

    @UseGuards(AuthGuard)
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: "submit business record for users with business account type",
    })
    @Post("/submit-business-record")
    async submitBusinessRecord(
        @User() user: UserModel,
        @Body(ValidationPipe) dto: SubmitBusinessRecordDto
    ) {
        return await this.authService.submitBusinessRecord(user, dto);
    }

    @HttpCode(HttpStatus.OK)
    @Post("login")
    async signIn(
        @Body(ValidationPipe) signInDto: UserSigInDto
    ): Promise<ApiResponse> {
        return await this.authService.userSignIn(signInDto);
    }
}
