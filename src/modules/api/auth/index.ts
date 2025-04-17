import { Module } from "@nestjs/common";
import { AuthService } from "./services";
import { JwtModule } from "@nestjs/jwt";
import { jwtSecret, TOKEN_EXPIRATION } from "@/config";
import { AuthController } from "./controllers/v1";
import { AuthGuard } from "./guard";
import { AdminAuthController } from "./controllers/v1/admin";
import { IdentityComplianceFactoryModule } from "@/modules/factory/identityCompliance";
export * from "./interfaces";
export * from "./errors";
import { PasswordService } from "./services/passworReset.services";
import { PasswordController } from "./controllers/v1/passwordReset";
import { TradingFactoryModule } from "@/modules/factory/trading";

@Module({
    imports: [
        JwtModule.register({
            global: true,
            secret: jwtSecret,
            signOptions: { expiresIn: TOKEN_EXPIRATION },
        }),
        IdentityComplianceFactoryModule,
        TradingFactoryModule,
    ],
    controllers: [AuthController, AdminAuthController, PasswordController],
    providers: [AuthService, AuthGuard, PasswordService],
    exports: [AuthService, AuthGuard],
})
export class AuthModule {}
