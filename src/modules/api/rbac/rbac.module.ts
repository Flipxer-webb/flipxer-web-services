import { Module } from "@nestjs/common";
import { RbacController } from "./controllers";
import { RbacService } from "./services";

@Module({
    controllers: [RbacController],
    providers: [RbacService],
    exports: [RbacService],
})
export class RbacModule {}
