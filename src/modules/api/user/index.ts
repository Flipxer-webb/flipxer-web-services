import { forwardRef, Global, Module } from "@nestjs/common";
import { AuthModule } from "../auth";
import { UserController } from "./controllers/v1";
import { UserService } from "./services";
import { AdminUserService } from "./services/admin";
import { AdminUserController } from "./controllers/v1/admin";
import { CachingModule } from "@/modules/core/redisCache";
export * from "./interfaces";
export * from "./errors";
export * from "./decorators";

@Global()
@Module({
    imports: [forwardRef(() => AuthModule), CachingModule],
    controllers: [UserController, AdminUserController],
    providers: [UserService, AdminUserService],
    exports: [UserService],
})
export class UserModule {}
