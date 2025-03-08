import { Module } from "@nestjs/common";
import { AuthService } from "./services";
import { JwtModule } from "@nestjs/jwt";
import { jwtSecret, TOKEN_EXPIRATION } from "@/config";
import { AuthController } from "./controllers/v1";
import { AuthGuard } from "./guard";
import { AdminAuthController } from "./controllers/v1/admin";
export * from "./interfaces";
export * from "./errors";
import { PasswordService } from "./services/passworReset.services";
import { PasswordController } from "./controllers/v1/passwordReset";

@Module({
    imports: [
        JwtModule.register({
            global: true,
            secret: jwtSecret,
            signOptions: { expiresIn: TOKEN_EXPIRATION },
        }),
    ],
    controllers: [AuthController, AdminAuthController, PasswordController],
    providers: [AuthService, AuthGuard, PasswordService],
    exports: [AuthService],
})
export class AuthModule {}
