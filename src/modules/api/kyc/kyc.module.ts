import { Module } from "@nestjs/common";
import { KycController } from "./controllers";
import { KycService } from "./services";
import { TierService } from "@/modules/api/auth/services/tier.service";

@Module({
    controllers: [KycController],
    providers: [KycService, TierService],
    exports: [KycService],
})
export class KycModule {}
