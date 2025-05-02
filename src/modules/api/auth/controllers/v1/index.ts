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
    SignInDto, // Replaced UserSigInDto with SignInDto
    SubmitBusinessRecordDto,
    VerifyEmailOtpDto,
    VerifyPhoneOtpDto,
    SendForgotPasswordDto,
    ResetPasswordDto,
} from "../../dtos";
import { AuthService } from "../../services";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { AuthGuard } from "../../guard";
import { User } from "@/modules/api/user";
import { User as UserModel } from "@prisma/client";

@ApiTags("user")
@Controller({
    path: "auth",
})
export class AuthController {
    constructor(private authService: AuthService) {}

    @Post("signup")
    @ApiOperation({ summary: "individual and business signup" })
    async signUp(@Body(ValidationPipe) signUpDto: SignUpDto, @Req() req: Request) {
        return await this.authService.signUp(signUpDto, req.ip);
    }

    @HttpCode(HttpStatus.OK)
    @Post("login")
    @ApiOperation({ summary: "user login" })
    async signIn(@Body(ValidationPipe) signInDto: SignInDto, @Req() req: Request) {
        return await this.authService.userSignIn(signInDto, req.ip);
    }

    @HttpCode(HttpStatus.OK)
    @Post("initiate-email-verification")
    @ApiOperation({ summary: "initiate email verification process" })
    async sendAccountVerificationEmail(
        @Body(ValidationPipe) sendVerificationCodeDto: SendEmailVerificationCodeDto
    ) {
        return await this.authService.sendAccountVerificationEmail(sendVerificationCodeDto);
    }

    @HttpCode(HttpStatus.OK)
    @Post("verify-email-otp")
    @ApiOperation({ summary: "verify email verification otp" })
    async verifyEmailOtp(@Body(ValidationPipe) verifyEmailOtpDto: VerifyEmailOtpDto) {
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

    // @UseGuards(AuthGuard)
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
    @ApiOperation({ summary: "document verification for users with individual account type" })
    @ApiBearerAuth("access-token")
    async documentVerification(
        @User() user: UserModel,
        @Body(ValidationPipe) dto: DocumentVerificationDto
    ) {
        return await this.authService.documentVerification(user, dto);
    }

    @UseGuards(AuthGuard)
    @HttpCode(HttpStatus.OK)
    @Post("submit-business-record")
    @ApiOperation({ summary: "submit business record for users with business account type" })
    @ApiBearerAuth("access-token")
    async submitBusinessRecord(
        @User() user: UserModel,
        @Body(ValidationPipe) dto: SubmitBusinessRecordDto
    ) {
        return await this.authService.submitBusinessRecord(user, dto);
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
}