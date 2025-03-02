import { Module } from "@nestjs/common";
import { AuthService } from "./services";
import { JwtModule } from "@nestjs/jwt";
import { jwtSecret, TOKEN_EXPIRATION } from "@/config";
import { AuthController } from "./controllers/v1";
import { AuthGuard } from "./guard";
import { AdminAuthController } from "./controllers/v1/admin";
export * from "./interfaces";
export * from "./errors";

@Module({
    imports: [
        JwtModule.register({
            global: true,
            secret: jwtSecret,
            signOptions: { expiresIn: TOKEN_EXPIRATION },
        }),
    ],
    controllers: [AuthController, AdminAuthController],
    providers: [AuthService, AuthGuard],
    exports: [AuthService],
})
export class AuthModule {}
