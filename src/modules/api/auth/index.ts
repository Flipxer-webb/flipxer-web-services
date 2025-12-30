import { forwardRef, Module } from "@nestjs/common";
import { AuthService } from "./services";
import { TierService } from "./services/tier.service";
import { TierVerificationService } from "./services/tier-verification.service";
import { TwoFactorRateLimitService } from "./services/two-factor-rate-limit.service";
import { BiometricService } from "./services/biometric.service";
import { JwtModule } from "@nestjs/jwt";
import { jwtSecret, TOKEN_EXPIRATION } from "@/config";
import { AuthController } from "./controllers/v1";
import { AdminAuthController } from "./controllers/v1/admin";
import { BiometricController } from "./controllers/v1/biometric";
import { AuthGuard, TwoFactorGuard } from "./guard";
import { IdentityComplianceFactoryModule } from "@/modules/factory/identityCompliance";
import { TradingModule } from "../trade";
import { PrismaModule } from "@/modules/core/prisma";
import { EmailModule } from "@/modules/core/email";
import { SessionModule } from "../session";
import { UploadModule } from "@/modules/core/upload";
import { CachingModule } from "@/modules/core/redisCache";
import { SettingModule } from "../settings";

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
        SessionModule,
        UploadModule,
        CachingModule,
        forwardRef(() => SettingModule),
    ],
    controllers: [AuthController, AdminAuthController, BiometricController],
    providers: [AuthService, AuthGuard, TierService, TierVerificationService, TwoFactorRateLimitService, BiometricService, TwoFactorGuard],
    exports: [AuthService, AuthGuard, TierService, TierVerificationService, TwoFactorRateLimitService, BiometricService, TwoFactorGuard],
})
export class AuthModule { }

