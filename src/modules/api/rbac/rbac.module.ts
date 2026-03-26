import { Module } from "@nestjs/common";
import { RbacController } from "./controllers";
import { RbacSeedController } from "./controllers/seed.controller";
import { RbacService } from "./services";
import { SessionModule } from "../session";

@Module({
    imports: [SessionModule],
    controllers: [RbacController, RbacSeedController],
    providers: [RbacService],
    exports: [RbacService],
})
export class RbacModule {}
