import { Module } from "@nestjs/common";
import { WebExtensionController } from "./controllers";
import { WebExtensionService } from "./services";

@Module({
    controllers: [WebExtensionController],
    providers: [WebExtensionService],
})
export class WebExtension {}
