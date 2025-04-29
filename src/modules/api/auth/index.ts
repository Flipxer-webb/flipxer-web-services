import { forwardRef, Module } from "@nestjs/common";
import { AuthService } from "./services";
import { JwtModule } from "@nestjs/jwt";
import { jwtSecret, TOKEN_EXPIRATION } from "@/config";
import { AuthController } from "./controllers/v1";
import { AuthGuard } from "./guard";
import { AdminAuthController } from "./controllers/v1/admin";
import { IdentityComplianceFactoryModule } from "@/modules/factory/identityCompliance";
export * from "./interfaces";
export * from "./errors";
import { TradingModule } from "../trade";

@Module({
    imports: [
        JwtModule.register({
            global: true,
            secret: jwtSecret,
            signOptions: { expiresIn: TOKEN_EXPIRATION },
        }),
        IdentityComplianceFactoryModule,
        forwardRef(() => TradingModule),
    ],
    controllers: [AuthController, AdminAuthController],
    providers: [AuthService, AuthGuard],
    exports: [AuthService, AuthGuard],
})
export class AuthModule {}
