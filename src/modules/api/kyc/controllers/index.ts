import {
    Controller,
    Get,
    Post,
    Put,
    Body,
    Param,
    Query,
    ParseIntPipe,
    UseGuards,
    Req,
    UnauthorizedException,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AuthGuard, EnabledAccountGuard } from "@/modules/api/auth/guard";
import { UserTypes, ADMIN_USER_TYPES, Permissions } from "@/modules/api/authorize/decorator";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { PermissionGuard } from "@/modules/api/authorize/guards/permission.guard";
import { PermissionName } from "@/modules/api/authorize/enums/role";
import { KycService } from "../services";
import {
    GetKycQueueDto,
    KycDecisionDto,
    UpdateUserTierDto,
    UpdateUserVerificationDto,
    GetKycStatsDto,
    ApproveDocumentDto,
    RejectDocumentDto,
} from "../dtos";

@UseGuards(AuthGuard, RoleGuard, EnabledAccountGuard, PermissionGuard)
@UserTypes(ADMIN_USER_TYPES)
@ApiTags("admin/kyc")
@Controller({ path: "admin/kyc" })
export class KycController {
    constructor(private readonly kycService: KycService) { }

    @ApiOperation({ summary: "Get KYC verification queue" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.KYC_READ])
    @Get("queue")
    async getKycQueue(@Query() query: GetKycQueueDto) {
        return await this.kycService.getKycQueue(query);
    }

    @ApiOperation({ summary: "Get KYC statistics and metrics" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.KYC_READ])
    @Get("stats")
    async getKycStats(@Query() query: GetKycStatsDto) {
        return await this.kycService.getKycStats(query);
    }

    @ApiOperation({ summary: "Get user KYC detail for review" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.KYC_READ])
    @Get("users/:userId")
    async getKycUserDetail(@Param("userId", ParseIntPipe) userId: number) {
        return await this.kycService.getKycUserDetail(userId);
    }

    @ApiOperation({ summary: "Process KYC decision (approve/reject/escalate)" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.KYC_APPROVE])
    @Post("decision")
    async processKycDecision(@Body() dto: KycDecisionDto, @Req() req: any) {
        const adminId = typeof req.user?.id === 'number' ? req.user.id : undefined;
        if (!adminId) throw new UnauthorizedException('Invalid admin session');
        return await this.kycService.processKycDecision(dto, adminId);
    }

    @ApiOperation({ summary: "Update user verification tier" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.KYC_APPROVE])
    @Put("users/:userId/tier")
    async updateUserTier(
        @Param("userId", ParseIntPipe) userId: number,
        @Body() dto: UpdateUserTierDto,
        @Req() req: any
    ) {
        const adminId = typeof req.user?.id === 'number' ? req.user.id : undefined;
        if (!adminId) throw new UnauthorizedException('Invalid admin session');
        return await this.kycService.updateUserTier(userId, dto, adminId);
    }

    @ApiOperation({ summary: "Manually update user verification status" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.KYC_APPROVE])
    @Put("users/:userId/verification")
    async updateUserVerification(
        @Param("userId", ParseIntPipe) userId: number,
        @Body() dto: UpdateUserVerificationDto,
        @Req() req: any
    ) {
        const adminId = typeof req.user?.id === 'number' ? req.user.id : undefined;
        if (!adminId) throw new UnauthorizedException('Invalid admin session');
        return await this.kycService.updateUserVerification(userId, dto, adminId);
    }

    @ApiOperation({ summary: "Approve address or income document" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.KYC_APPROVE])
    @Post("approve-document")
    async approveDocument(@Body() dto: ApproveDocumentDto, @Req() req: any) {
        const adminId = typeof req.user?.id === 'number' ? req.user.id : undefined;
        if (!adminId) throw new UnauthorizedException('Invalid admin session');
        return await this.kycService.approveDocument(dto, adminId);
    }

    @ApiOperation({ summary: "Reject address or income document" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.KYC_APPROVE])
    @Post("reject-document")
    async rejectDocument(@Body() dto: RejectDocumentDto, @Req() req: any) {
        const adminId = typeof req.user?.id === 'number' ? req.user.id : undefined;
        if (!adminId) throw new UnauthorizedException('Invalid admin session');
        return await this.kycService.rejectDocument(dto, adminId);
    }
}
