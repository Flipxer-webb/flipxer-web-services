import { Module } from "@nestjs/common";
import { RbacController } from "./controllers";
import { RbacSeedController } from "./controllers/seed.controller";
import { RbacService } from "./services";

@Module({
    controllers: [RbacController, RbacSeedController],
    providers: [RbacService],
    exports: [RbacService],
})
export class RbacModule {}
