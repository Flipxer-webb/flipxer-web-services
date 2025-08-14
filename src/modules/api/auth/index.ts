import { forwardRef, Module } from "@nestjs/common";
import { AuthService } from "./services";
import { JwtModule } from "@nestjs/jwt";
import { jwtSecret, TOKEN_EXPIRATION } from "@/config";
import { AuthController } from "./controllers/v1";
import { AdminAuthController } from "./controllers/v1/admin";
import { AuthGuard} from "./guard";
import { IdentityComplianceFactoryModule } from "@/modules/factory/identityCompliance";
import { TradingModule } from "../trade";
import { PrismaModule } from "@/modules/core/prisma";
import { EmailModule } from "@/modules/core/email";

export * from "./interfaces";
export * from "./errors";

@Module({
    imports: [
        JwtModule.register({
            global: true,
            secret: jwtSecret,
            signOptions: { expiresIn: TOKEN_EXPIRATION },
        }),
        IdentityComplianceFactoryModule,
        forwardRef(() => TradingModule),
        PrismaModule,
        EmailModule,
    ],
    controllers: [AuthController, AdminAuthController],
    providers: [
        AuthService,
        AuthGuard,
    ],
    exports: [
        AuthService,
        AuthGuard,
    ],
})
export class AuthModule {}