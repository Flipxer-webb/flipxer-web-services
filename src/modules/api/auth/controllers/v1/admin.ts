import {
    Body,
    Controller,
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
import { ClientData, ClientDataInterface } from "@/modules/api/user";
import { ApiResponse } from "@/utils/api-response-util";
import { CountryBlockGuard } from "../../guard";

@UseGuards(CountryBlockGuard)
@ApiTags("admin")
@Controller({
    path: "admin/auth",
})

export class AdminAuthController {
    constructor(private authService: AuthService) {}

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
}
