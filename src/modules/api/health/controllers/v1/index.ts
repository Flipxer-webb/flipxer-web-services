import { Controller, Get } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";

@ApiTags("Health")
@Controller({ path: "health", version: "1" })
export class HealthController {
    @Get()
    @ApiOperation({ summary: "Health check endpoint" })
    @ApiResponse({ status: 200, description: "Server is healthy" })
    check() {
        return {
            success: true,
            message: "OK",
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
        };
    }

    @Get("ping")
    @ApiOperation({ summary: "Simple ping endpoint for keep-alive" })
    @ApiResponse({ status: 200, description: "Pong" })
    ping() {
        return { pong: true };
    }
}
