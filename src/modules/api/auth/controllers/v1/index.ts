import { ApiResponse } from "@/utils/api-response-util";
import {
    Body,
    Controller,
    HttpCode,
    HttpStatus,
    Post,
    Req,
    ValidationPipe,
} from "@nestjs/common";

import { Request } from "express";
import { SignUpDto, UserSigInDto } from "../../dtos";
import { AuthService } from "../../services";

@Controller({
    path: "auth",
})
export class AuthController {
    constructor(private authService: AuthService) {}

    @Post("signup")
    async signUp(
        @Body(ValidationPipe) signUpDto: SignUpDto,
        @Req() req: Request
    ): Promise<ApiResponse> {
        return await this.authService.signUp(signUpDto, req.ip);
    }

    @HttpCode(HttpStatus.OK)
    @Post("login")
    async signIn(
        @Body(ValidationPipe) signInDto: UserSigInDto
    ): Promise<ApiResponse> {
        return await this.authService.userSignIn(signInDto);
    }
}
