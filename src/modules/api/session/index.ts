import { Module } from "@nestjs/common";
import { SessionController } from "./controllers/v1";
import { SessionService } from "./services";
import { PrismaModule } from "@/modules/core/prisma";

export * from "./interfaces";
export * from "./errors";
export * from "./dtos";

@Module({
    imports: [PrismaModule],
    controllers: [SessionController],
    providers: [SessionService],
    exports: [SessionService],
})
export class SessionModule {}
