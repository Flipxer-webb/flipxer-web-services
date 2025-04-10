import { forwardRef, Global, Module } from "@nestjs/common";
import { AuthModule } from "../auth";
import { UserController } from "./controllers/v1";
import { UserService } from "./services";
import { RecoveryEmailService } from "./services/recovery-email";
import { AdminUserController } from "./controllers/v1/admin";
import { RecoveryEmailController } from "./controllers/v1/recovery-email";
export * from "./interfaces";
export * from "./errors";
export * from "./decorators";


@Global()
@Module({
    imports: [forwardRef(() => AuthModule)],
    controllers: [UserController, AdminUserController, RecoveryEmailController],
    providers: [UserService, RecoveryEmailService],
    exports: [UserService],
})
export class UserModule {}
