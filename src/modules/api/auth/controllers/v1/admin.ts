import {
    Body,
    Controller,
    HttpCode,
    HttpStatus,
    Post,
    ValidationPipe,
} from "@nestjs/common";
import { ApiResponse } from "@/utils/api-response-util";
import { SignInDto } from "../../dtos";
import { AuthService } from "../../services";
import { ClientData, ClientDataInterface } from "@/modules/api/user";

@Controller({
    path: "admin/auth",
})
export class AdminAuthController {
    constructor(private authService: AuthService) {}

    @HttpCode(HttpStatus.OK)
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
}
