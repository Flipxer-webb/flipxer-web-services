import { forwardRef, Global, Module } from "@nestjs/common";
import { AuthModule } from "../auth";
import { TradingModule } from "../trade";
import { UserController } from "./controllers/v1";
import { PreferencesController } from "./controllers/v1/preferences.controller";
import { UserService } from "./services";
import { AdminUserService } from "./services/admin";
import { PreferencesService } from "./services/preferences.service";
import { AdminUserController } from "./controllers/v1/admin";
import { CachingModule } from "@/modules/core/redisCache";
import { TierService } from "../auth/services/tier.service";
import { PrismaModule } from "@/modules/core/prisma";
export * from "./interfaces";
export * from "./errors";
export * from "./decorators";

@Global()
@Module({
    imports: [forwardRef(() => AuthModule), forwardRef(() => TradingModule), CachingModule, PrismaModule],
    controllers: [UserController, AdminUserController, PreferencesController],
    providers: [UserService, AdminUserService, TierService, PreferencesService],
    exports: [UserService, TierService, PreferencesService],
})
export class UserModule {}
