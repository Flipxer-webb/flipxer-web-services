import { Controller, Get, VERSION_NEUTRAL } from "@nestjs/common";
import { WebExtensionService } from "../services";

@Controller({
    version: VERSION_NEUTRAL,
})
export class WebExtensionController {
    constructor(private readonly webExtensionService: WebExtensionService) {}

    // Health check
    @Get("health")
    health() {
        return this.webExtensionService.health();
    }
}
