import { SwaggerResponse, ApiResponse } from "@/utils/api-response-util";
import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    Query,
    UseGuards,
    ValidationPipe,
} from "@nestjs/common";

import { SettingService } from "../../services";
import {
    ApiTags,
    ApiOperation,
    ApiBearerAuth,
    ApiBody,
    ApiResponse as SwaggerApiResponse,
} from "@nestjs/swagger";

@ApiTags("admin")
@Controller({
    path: "admin/settings",
})
export class AdminSettingController {
    constructor(private settingService: SettingService) {}

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "get supported assets list" })
    @Get("supported-assets")
    async getSupportedAssets() {
        return this.settingService.getSupportedNetworks();
    }
}
