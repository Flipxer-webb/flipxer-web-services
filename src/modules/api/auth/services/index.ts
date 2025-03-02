import { Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { SignUpDto, SignInDto, UserSigInDto } from "../dtos";

import * as bcrypt from "bcryptjs";
import { ApiResponse, buildResponse } from "@/utils/api-response-util";
import { PrismaService } from "@/modules/core/prisma/services";
import { EmailService } from "@/modules/core/email/services/email.service";
import { encrypt, formatName, generateId } from "@/utils";
import { LoginPlatform, SignInOptions } from "../interfaces";

@Injectable()
export class AuthService {
    constructor(
        private jwtService: JwtService,
        private prisma: PrismaService,
        private emailService: EmailService
    ) {}

    async hashPassword(password: string): Promise<string> {
        return await bcrypt.hash(password, 10);
    }

    async comparePassword(password: string, hash: string): Promise<boolean> {
        return await bcrypt.compare(password, hash);
    }

    async signUp(options: SignUpDto, ip: string): Promise<ApiResponse> {
        return buildResponse({
            message: "Account successfully created",
            data: {},
        });
    }

    async userSignIn(options: UserSigInDto): Promise<ApiResponse> {
        return await this.signIn(options, LoginPlatform.USER);
    }

    async adminSignIn(options: SignInDto, ip: string): Promise<ApiResponse> {
        return await this.signIn(options, LoginPlatform.ADMIN);
    }

    async signIn(
        options: SignInOptions,
        loginPlatform: LoginPlatform
    ): Promise<ApiResponse> {
        const user = await this.prisma.user.findUnique({
            where: {
                email: options.email,
            },
            select: {
                identifier: true,
            },
        });

        const accessToken = await this.jwtService.signAsync({
            sub: user.identifier,
        });

        return buildResponse({
            message: "Login successful",
            data: {
                accessToken,
            },
        });
    }
}
