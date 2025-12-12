import { Module } from "@nestjs/common";
import { KycController } from "./controllers";
import { KycService } from "./services";

@Module({
    controllers: [KycController],
    providers: [KycService],
    exports: [KycService],
})
export class KycModule {}
