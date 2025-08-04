import {
    Body,
    Controller,
    HttpCode,
    HttpStatus,
    Post,
    ValidationPipe,
    UseGuards
} from "@nestjs/common";
import {
    ApiTags,
    ApiOperation,
    ApiResponse as SwaggerApiResponse,
} from "@nestjs/swagger";
import { SignInDto} from "../../dtos";
import { AuthService } from "../../services";
import { ClientData, ClientDataInterface } from "@/modules/api/user";
import { ApiResponse } from "@/utils/api-response-util";


@ApiTags("admin")
@Controller({
    path: "admin/auth",
})
export class AdminAuthController {
    constructor(private authService: AuthService) {}

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Admin login" })
    @SwaggerApiResponse({ status: HttpStatus.OK, description: "Login successful" })
    @Post("login")
    async signIn(
        @Body(ValidationPipe) signInDto: SignInDto,
        @ClientData() clientData: ClientDataInterface
    ): Promise<ApiResponse> {
        return await this.authService.adminSignIn(signInDto, clientData.ipAddress);
    }
}