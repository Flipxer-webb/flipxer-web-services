import {
    Body,
    Controller,
    HttpCode,
    HttpStatus,
    Post,
    ValidationPipe,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { UserSigInDto } from "../../dtos";
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
    @ApiOperation({ summary: "admin login" })
    @Post("login")
    async signIn(
        @Body(ValidationPipe) signInDto: UserSigInDto,
        @ClientData() clientData: ClientDataInterface
    ): Promise<ApiResponse> {
        // The return type is still the interface
        return await this.authService.adminSignIn(
            signInDto,
            clientData.ipAddress
        );
    }
}
