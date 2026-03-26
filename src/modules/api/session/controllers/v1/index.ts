import {
    Controller,
    Get,
    Post,
    Delete,
    Body,
    UseGuards,
    HttpCode,
    HttpStatus,
    Req,
    Headers,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { SessionService } from "../../services";
import { AuthGuard } from "@/modules/api/auth/guard";
import { RevokeSessionDto, ExtendSessionDto } from "../../dtos";
import { RequestWithUser } from "@/modules/api/auth/interfaces";
import { ApiResponse } from "@/utils/api-response-util";

@ApiTags("sessions")
@ApiBearerAuth()
@Controller({ path: "sessions" })
export class SessionController {
    constructor(private readonly sessionService: SessionService) { }

    @Get()
    @UseGuards(AuthGuard)
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Get all active sessions for current user" })
    async getSessions(
        @Req() req: RequestWithUser,
        @Headers("x-session-id") sessionId?: string
    ): Promise<ApiResponse> {
        return this.sessionService.getUserSessions(req.user, sessionId);
    }

    @Delete("revoke")
    @UseGuards(AuthGuard)
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Revoke a specific session" })
    async revokeSession(
        @Req() req: RequestWithUser,
        @Body() dto: RevokeSessionDto,
        @Headers("x-session-id") currentSessionId?: string
    ): Promise<ApiResponse> {
        return this.sessionService.revokeSession(
            req.user,
            dto.sessionId,
            currentSessionId
        );
    }

    @Delete("revoke-all")
    @UseGuards(AuthGuard)
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Revoke all sessions except current" })
    async revokeAllSessions(
        @Req() req: RequestWithUser,
        @Headers("x-session-id") currentSessionId: string
    ): Promise<ApiResponse> {
        if (!currentSessionId) {
            return {
                success: false,
                message: "Current session ID is required",
            };
        }
        return this.sessionService.revokeAllOtherSessions(
            req.user,
            currentSessionId
        );
    }

    @Post("extend")
    @UseGuards(AuthGuard)
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Extend current session expiration" })
    async extendSession(
        @Req() req: RequestWithUser,
        @Body() dto: ExtendSessionDto
    ): Promise<ApiResponse> {
        return this.sessionService.extendSession(req.user, dto.sessionId);
    }

    @Post("invalidate-current")
    @UseGuards(AuthGuard)
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Invalidate current session (logout)" })
    async invalidateCurrentSession(
        @Req() req: RequestWithUser,
        @Body() dto: ExtendSessionDto
    ): Promise<ApiResponse> {
        return this.sessionService.invalidateCurrentSession(
            req.user,
            dto.sessionId
        );
    }

    @Get("count")
    @UseGuards(AuthGuard)
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Get active session count" })
    async getSessionCount(@Req() req: RequestWithUser): Promise<ApiResponse> {
        const count = await this.sessionService.getActiveSessionCount(
            req.user.id
        );
        return {
            success: true,
            message: "Session count retrieved",
            data: { count },
        };
    }

    @Post("cleanup-bots")
    @UseGuards(AuthGuard)
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Cleanup bot and health check sessions (admin only)" })
    async cleanupBotSessions(): Promise<ApiResponse> {
        const cleanedCount = await this.sessionService.cleanupBotSessions();
        return {
            success: true,
            message: `Cleaned up ${cleanedCount} bot/health-check sessions`,
            data: { cleanedCount },
        };
    }
}
