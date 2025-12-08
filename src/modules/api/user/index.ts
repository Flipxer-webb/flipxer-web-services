import { forwardRef, Global, Module } from "@nestjs/common";
import { AuthModule } from "../auth";
import { UserController } from "./controllers/v1";
import { UserService } from "./services";
import { AdminUserService } from "./services/admin";
import { AdminUserController } from "./controllers/v1/admin";
import { CachingModule } from "@/modules/core/redisCache";
import { TierService } from "../auth/services/tier.service";
import { PrismaModule } from "@/modules/core/prisma";
export * from "./interfaces";
export * from "./errors";
export * from "./decorators";

@Global()
@Module({
    imports: [forwardRef(() => AuthModule), CachingModule, PrismaModule],
    controllers: [UserController, AdminUserController],
    providers: [UserService, AdminUserService, TierService],
    exports: [UserService, TierService],
})
export class UserModule {}
