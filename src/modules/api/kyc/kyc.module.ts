import { Module, forwardRef } from "@nestjs/common";
import { KycController } from "./controllers";
import { KycService } from "./services";
import { AuthModule } from "@/modules/api/auth";
import { PrismaModule } from "@/modules/core/prisma";

@Module({
    imports: [
        forwardRef(() => AuthModule),
        PrismaModule,
    ],
    controllers: [KycController],
    providers: [KycService],
    exports: [KycService],
})
export class KycModule {}
