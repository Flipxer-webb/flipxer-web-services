import { Module, forwardRef } from "@nestjs/common";
import { KycController } from "./controllers";
import { KycService } from "./services";
import { AuthModule } from "@/modules/api/auth";
import { PrismaModule } from "@/modules/core/prisma";
import { TradingModule } from "@/modules/api/trade";
import { SessionModule } from "@/modules/api/session";

@Module({
    imports: [
        forwardRef(() => AuthModule),
        forwardRef(() => TradingModule),
        PrismaModule,
        SessionModule,
    ],
    controllers: [KycController],
    providers: [KycService],
    exports: [KycService],
})
export class KycModule {}
