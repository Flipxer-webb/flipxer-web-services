import { Module } from "@nestjs/common";
import { AmlController } from "./controllers";
import { AmlService } from "./services";
import { AmlBotLib } from "@/libs/amlbot";
import { amlBotConfig } from "@/config";
import { SessionModule } from "@/modules/api/session";

const amlBotProvider = {
    provide: AmlBotLib,
    useFactory() {
        return new AmlBotLib({
            baseURL: amlBotConfig.baseUrl,
            accessKey: amlBotConfig.accessKey,
            accessId: amlBotConfig.accessId,
        });
    },
};

@Module({
    imports: [SessionModule],
    controllers: [AmlController],
    providers: [amlBotProvider, AmlService],
    exports: [AmlService],
})
export class AmlModule {}
