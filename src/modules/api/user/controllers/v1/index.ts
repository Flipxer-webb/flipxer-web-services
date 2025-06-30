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
import { AuthGuard, EnabledAccountGuard } from "@/modules/api/auth/guard";
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
@UseGuards(AuthGuard, EnabledAccountGuard)
export class UserController {
    constructor(private readonly userService: UserService) {}

    @ApiOperation({ summary: "Get client profile" })
    @ApiBearerAuth("access-token")
    @Get("profile")
    async getProfile(@User() user: UserModel) {
        return await this.userService.getProfile(user);
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
        return await this.userService.getUserWallets(user, query);
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
}
