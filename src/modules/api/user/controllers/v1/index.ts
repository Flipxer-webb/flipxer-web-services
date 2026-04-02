import {
    Controller,
    Get,
    Post,
    Body,
    UsePipes,
    ValidationPipe,
    UseGuards,
    Query,
    UseInterceptors,
    UploadedFile,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
    ApiTags,
    ApiOperation,
    ApiBearerAuth,
    ApiBody,
    ApiConsumes,
} from "@nestjs/swagger";
import { UserService } from "../../services";
import {
    AuthGuard,
    CountryBlockGuard,
    EnabledAccountGuard,
} from "@/modules/api/auth/guard";
import { RateLimiterGuard, RateLimit } from "@/modules/core/rate-limit/guards/rate-limiter.guard";
import {
    GetUserAssetsDto,
    UpdateProfilePasswordDto,
    UpdateUserDetailsDto,
    SendRecoveryEmailOtpDto,
    VerifyRecoveryEmailOtpDto,
} from "../../dtos";
import { User } from "../../decorators";
import { User as UserModel } from "@prisma/client";

@ApiTags("user")
@Controller({
    path: "user",
})
@UseGuards(RateLimiterGuard, CountryBlockGuard, AuthGuard, EnabledAccountGuard)
export class UserController {
    constructor(private readonly userService: UserService) { }

    @ApiOperation({ summary: "Get client profile" })
    @ApiBearerAuth("access-token")
    @Get("profile")
    async getProfile(@User() user: UserModel) {
        return await this.userService.getProfile(user);
    }

    @ApiOperation({ summary: "Get user daily withdrawal usage and limits" })
    @ApiBearerAuth("access-token")
    @Get("withdrawal-usage")
    async getWithdrawalUsage(@User() user: UserModel) {
        return await this.userService.getWithdrawalUsage(user);
    }

    @ApiOperation({ summary: "Update user details" })
    @ApiBearerAuth("access-token")
    @ApiConsumes("multipart/form-data")
    @ApiBody({
        schema: {
            type: "object",
            properties: {
                firstName: { type: "string", nullable: true },
                lastName: { type: "string", nullable: true },
                phone: { type: "string", nullable: true },
                gender: {
                    type: "string",
                    enum: ["MALE", "FEMALE"],
                    nullable: true,
                },
                dateOfBirth: { type: "string", format: "date", nullable: true },
                country: { type: "string", enum: ["NIGERIA"], nullable: true },
                photo: {
                    type: "string",
                    format: "binary",
                    description: "Profile image file (e.g., PNG, JPEG)",
                },
                recoveryEmail: { type: "string", format: "date", nullable: true },

            },
        },
    })
    @Post("profile/update-details")
    @UsePipes(new ValidationPipe())
    @UseInterceptors(FileInterceptor("photo"))
    async updateUserDetails(
        @Body() dto: UpdateUserDetailsDto,
        @UploadedFile() photo: Express.Multer.File,
        @User() user: UserModel
    ) {
        return await this.userService.updateUserDetails(dto, user, photo);
    }

    @ApiOperation({ summary: "Update user password" })
    @ApiBearerAuth("access-token")
    @Post("profile/update-password")
    @UsePipes(new ValidationPipe())
    async updateProfilePassword(
        @Body() updateProfilePasswordDto: UpdateProfilePasswordDto,
        @User() user: UserModel
    ) {
        return await this.userService.updateProfilePassword(
            updateProfilePasswordDto,
            user
        );
    }

    @ApiOperation({ summary: "Get user wallet grand balance" })
    @ApiBearerAuth("access-token")
    @Get("wallets/grand-balance")
    async getUserAggregatedWalletBalance(@User() user: UserModel) {
        return await this.userService.getUserAggregatedWalletBalance(user);
    }

    @ApiOperation({ summary: "Get user digital wallet" })
    @ApiBearerAuth("access-token")
    @Get("wallets")
    async getUserWallets(
        @User() user: UserModel,
        @Query() query: GetUserAssetsDto
    ) {
        return await this.userService.getUserWallets(user.id, query);
    }

    @ApiOperation({
        summary:
            "Send OTP to authenticated user's email for recovery email verification",
    })
    @ApiBearerAuth("access-token")
    @Post("recovery-email/send-otp")
    @UsePipes(new ValidationPipe())
    async sendRecoveryEmailOtp(
        @Body() dto: SendRecoveryEmailOtpDto,
        @User() user: UserModel
    ) {
        return await this.userService.sendRecoveryEmailOtp(dto, user);
    }

    @ApiOperation({ summary: "Verify recovery email OTP" })
    @ApiBearerAuth("access-token")
    @Post("recovery-email/verify-otp")
    @UsePipes(new ValidationPipe())
    async verifyRecoveryEmailOtp(
        @Body() dto: VerifyRecoveryEmailOtpDto,
        @User() user: UserModel
    ) {
        return await this.userService.verifyRecoveryEmailOtp(dto, user);
    }

    @ApiOperation({ summary: "Update push notification token" })
    @ApiBearerAuth("access-token")
    @ApiBody({
        schema: {
            type: "object",
            properties: {
                token: {
                    type: "string",
                    nullable: true,
                    description: "FCM token for push notifications. Pass null to disable.",
                },
                deviceName: {
                    type: "string",
                    nullable: true,
                    description: "Human-readable device name, e.g. 'Chrome on Windows'",
                },
                platform: {
                    type: "string",
                    nullable: true,
                    description: "Platform identifier: web, android, or ios",
                },
            },
        },
    })
    @Post("notification-token")
    async updateNotificationToken(
        @Body("token") token: string | null,
        @Body("deviceName") deviceName: string | undefined,
        @Body("platform") platform: string | undefined,
        @User() user: UserModel
    ) {
        return await this.userService.updateNotificationToken(user, token, deviceName, platform);
    }

    @ApiOperation({ summary: "Lookup user by email" })
    @ApiBearerAuth("access-token")
    @Get("lookup")
    @RateLimit({ limit: 5, windowSeconds: 60, errorMessage: "Too many lookup attempts. Please try again later." })
    async lookupUser(@Query("email") email: string) {
        return await this.userService.getUserByEmail(email);
    }

    @ApiOperation({ summary: "Get Intercom identity verification hash" })
    @ApiBearerAuth("access-token")
    @Get("intercom-hash")
    async getIntercomHash(@User() user: UserModel) {
        return await this.userService.getIntercomHash(user);
    }
}

