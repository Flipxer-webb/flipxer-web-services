import {
    Body,
    Controller,
    HttpCode,
    HttpStatus,
    Post,
    ValidationPipe,
} from "@nestjs/common";
import { ApiTags, ApiBody, ApiResponse as SwaggerApiResponse } from "@nestjs/swagger";
import { SignInDto } from "../../dtos"; // Replaced UserSigInDto with SignInDto
import { AuthService } from "../../services";
import { ClientData, ClientDataInterface } from "@/modules/api/user";
import {  ApiResponse } from "@/utils/api-response-util";

@ApiTags('Admin Authentication')
@Controller({
    path: "admin/auth",
})
export class AdminAuthController {
    constructor(private authService: AuthService) {}

    @HttpCode(HttpStatus.OK)
    @Post("login")
    @ApiBody({ description: 'User login credentials', type: SignInDto }) // Updated to SignInDto
    async signIn(
        @Body(ValidationPipe) signInDto: SignInDto, // Updated to SignInDto
        @ClientData() clientData: ClientDataInterface
    ): Promise<ApiResponse> {
        return await this.authService.adminSignIn(
            signInDto,
            clientData.ipAddress
        );
    }
}