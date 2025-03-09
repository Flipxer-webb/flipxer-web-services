
import {
    Body,
    Controller,
    HttpCode,
    HttpStatus,
    Post,
    ValidationPipe,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBody, ApiResponse as SwaggerApiResponse } from "@nestjs/swagger";
import { UserSigInDto } from "../../dtos"; 
import { AuthService } from "../../services";
import { ClientData, ClientDataInterface } from "@/modules/api/user";
import {SwaggerResponse, ApiResponse } from "@/utils/api-response-util";

@ApiTags('Admin Authentication')
@Controller({
    path: "admin/auth",
})
export class AdminAuthController {
    constructor(private authService: AuthService) {}

    @HttpCode(HttpStatus.OK)
    @Post("login")
    @ApiOperation({ summary: 'Admin login', description: 'Allows an admin to sign in.' })
    @ApiBody({ description: 'User login credentials', type: UserSigInDto })
    @SwaggerApiResponse({ status: 200, description: 'Login successful', type: SwaggerResponse })  // This is the class, not the interface
    @SwaggerApiResponse({ status: 401, description: 'Unauthorized' })
    @SwaggerApiResponse({ status: 400, description: 'Bad Request - Validation Error' })
    async signIn(
        @Body(ValidationPipe) signInDto: UserSigInDto,
        @ClientData() clientData: ClientDataInterface
    ): Promise<ApiResponse> {  // The return type is still the interface
        return await this.authService.adminSignIn(
            signInDto,
            clientData.ipAddress
        );
    }
}