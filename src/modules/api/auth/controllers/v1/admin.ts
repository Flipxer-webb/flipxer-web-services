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
import { SignInDto, UnflagUserDto } from "../../dtos";
import { AuthService } from "../../services";
import { ClientData, ClientDataInterface } from "@/modules/api/user";
import { ApiResponse } from "@/utils/api-response-util";
import { AuthGuard } from "../../guard";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { UserType } from "@prisma/client";
import { UserTypes } from "@/modules/api/authorize/decorator";


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

    @UseGuards(AuthGuard, RoleGuard)
    @UserTypes([UserType.ADMIN])
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Unflag a user account" })
    @SwaggerApiResponse({ status: HttpStatus.OK, description: "Account unflagged successfully" })
    @Post("unflag")
    async unflagUser(
        @Body(ValidationPipe) unflagUserDto: UnflagUserDto
    ): Promise<ApiResponse> {
        return await this.authService.unflagUser(unflagUserDto);
    }
}