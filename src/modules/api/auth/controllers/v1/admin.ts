import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Post,
    UseGuards,
    ValidationPipe,
} from "@nestjs/common";
import {
    ApiTags,
    ApiOperation,
    ApiResponse as SwaggerApiResponse,
} from "@nestjs/swagger";
import { SignInDto, Reset2FARateLimitDto } from "../../dtos";
import { AuthService } from "../../services";
import { TierService } from "../../services/tier.service";
import { ClientData, ClientDataInterface } from "@/modules/api/user";
import { ApiResponse, buildResponse } from "@/utils/api-response-util";
import { CountryBlockGuard, AuthGuard, EnabledAccountGuard } from "../../guard";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";

@UseGuards(CountryBlockGuard)
@ApiTags("admin")
@Controller({
    path: "admin/auth",
})

export class AdminAuthController {
    constructor(
        private authService: AuthService,
        private tierService: TierService
    ) {}

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "admin login" })
    @Post("login")
    async signIn(
        @Body(ValidationPipe) signInDto: SignInDto,
        @ClientData() clientData: ClientDataInterface
    ): Promise<ApiResponse> {
        return await this.authService.adminSignIn(
            signInDto,
            clientData.ipAddress
        );
    }

    @UseGuards(AuthGuard, RoleGuard, EnabledAccountGuard)
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ 
        summary: "Reset 2FA rate limit for a user",
        description: "Admin endpoint to unlock a user who has been rate-limited due to failed 2FA attempts"
    })
    @Post("reset-2fa-rate-limit")
    async reset2FARateLimit(
        @Body(ValidationPipe) dto: Reset2FARateLimitDto
    ): Promise<ApiResponse> {
        return await this.authService.reset2FARateLimit(dto);
    }

    @UseGuards(AuthGuard, RoleGuard, EnabledAccountGuard)
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ 
        summary: "Update tiers for all users",
        description: "One-time migration endpoint to update user tiers based on verification status"
    })
    @Post("update-all-user-tiers")
    async updateAllUserTiers(): Promise<ApiResponse> {
        const result = await this.tierService.updateAllUserTiers();
        return buildResponse({
            message: `Updated ${result.updated} user tiers. ${result.unchanged} unchanged, ${result.errors} errors.`,
            data: result,
        });
    }

    @UseGuards(AuthGuard, RoleGuard, EnabledAccountGuard)
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ 
        summary: "Reset user verification for testing",
        description: "Admin endpoint to reset a user's verification status and tier to 0 for testing purposes"
    })
    @Post("reset-user-for-testing")
    async resetUserForTesting(
        @Body(ValidationPipe) dto: { email: string }
    ): Promise<ApiResponse> {
        const result = await this.tierService.resetUserForTesting(dto.email);
        return buildResponse({
            message: `User ${dto.email} reset to Tier 0`,
            data: result,
        });
    }
}
