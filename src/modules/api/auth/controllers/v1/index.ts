import {SwaggerResponse, ApiResponse } from "@/utils/api-response-util";
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
import { ApiTags, ApiOperation, ApiBearerAuth, ApiBody, ApiResponse as SwaggerApiResponse } from "@nestjs/swagger";
import { AuthGuard } from "../../guard";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { User } from "@/modules/api/user";
import { User as UserModel } from "@prisma/client";

@ApiTags("user")
@Controller({
    path: "auth",
})
export class AuthController {
    constructor(private authService: AuthService) {}

    @Post("signup")
    @ApiOperation({ summary: 'User login', description: 'Allows an admin to sign in.' })
    @ApiBody({ description: 'User login credentials', type: UserSigInDto })
    @SwaggerApiResponse({ status: 200, description: 'Login successful', type: SwaggerResponse })  // This is the class, not the interface
    @SwaggerApiResponse({ status: 401, description: 'Unauthorized' })
    @SwaggerApiResponse({ status: 400, description: 'Bad Request - Validation Error' })
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
    @ApiBearerAuth("access-token")
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
        summary: "document verification for users with individual account type",
    })
    @ApiBearerAuth("access-token")
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
    @ApiBearerAuth("access-token")
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
        @Body(ValidationPipe) signInDto: UserSigInDto,
        @Req() req: Request // Include Request object to get client IP
    ): Promise<ApiResponse> {
        return await this.authService.userSignIn(signInDto, req.ip); // Pass signInDto and req.ip
    }
}
