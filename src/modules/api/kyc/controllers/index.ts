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
    BadRequestException,
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
    RunKycVerificationLookupDto,
} from "../dtos";

@UseGuards(AuthGuard, RoleGuard, EnabledAccountGuard, PermissionGuard)
@UserTypes(ADMIN_USER_TYPES)
@ApiTags("admin/kyc")
@Controller({ path: "admin/kyc" })
export class KycController {
    constructor(private readonly kycService: KycService) { }

    private getAdminId(req: any): number {
        const adminId = typeof req.user?.id === "number" ? req.user.id : undefined;
        if (!adminId) throw new UnauthorizedException("Invalid admin session");
        return adminId;
    }

    private requireLegacyDecisionAction(dto: KycDecisionDto): KycDecisionDto & { action: "APPROVE" | "REJECT" | "ESCALATE" } {
        if (!dto.action) {
            throw new BadRequestException("Decision action is required for the legacy decision route");
        }

        return dto as KycDecisionDto & { action: "APPROVE" | "REJECT" | "ESCALATE" };
    }

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

    @ApiOperation({ summary: "Run a fresh provider lookup for a user's KYC evidence" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.KYC_APPROVE])
    @Post("verification")
    async runKycVerificationLookup(@Body() dto: RunKycVerificationLookupDto, @Req() req: any) {
        const adminId = this.getAdminId(req);
        return await this.kycService.runVerificationLookup(dto, adminId);
    }

    @ApiOperation({ summary: "Approve a KYC verification" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.KYC_APPROVE])
    @Post("decision/approve")
    async approveKycDecision(@Body() dto: KycDecisionDto, @Req() req: any) {
        const adminId = this.getAdminId(req);
        return await this.kycService.processKycDecision({ ...dto, action: "APPROVE" }, adminId);
    }

    @ApiOperation({ summary: "Reject a KYC verification" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.KYC_REJECT])
    @Post("decision/reject")
    async rejectKycDecision(@Body() dto: KycDecisionDto, @Req() req: any) {
        const adminId = this.getAdminId(req);
        return await this.kycService.processKycDecision({ ...dto, action: "REJECT" }, adminId);
    }

    @ApiOperation({ summary: "Escalate a KYC verification" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.KYC_ESCALATE])
    @Post("decision/escalate")
    async escalateKycDecision(@Body() dto: KycDecisionDto, @Req() req: any) {
        const adminId = this.getAdminId(req);
        return await this.kycService.processKycDecision({ ...dto, action: "ESCALATE" }, adminId);
    }

    @ApiOperation({ summary: "Process KYC decision (deprecated compatibility route)" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.KYC_APPROVE])
    @Post("decision")
    async processLegacyKycDecision(@Body() dto: KycDecisionDto, @Req() req: any) {
        const adminId = this.getAdminId(req);
        return await this.kycService.processKycDecision(this.requireLegacyDecisionAction(dto), adminId);
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
        const adminId = this.getAdminId(req);
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
        const adminId = this.getAdminId(req);
        return await this.kycService.updateUserVerification(userId, dto, adminId);
    }

    @ApiOperation({ summary: "Approve address or income document" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.KYC_APPROVE])
    @Post("approve-document")
    async approveDocument(@Body() dto: ApproveDocumentDto, @Req() req: any) {
        const adminId = this.getAdminId(req);
        return await this.kycService.approveDocument(dto, adminId);
    }

    @ApiOperation({ summary: "Reject address or income document" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.KYC_REJECT])
    @Post("reject-document")
    async rejectDocument(@Body() dto: RejectDocumentDto, @Req() req: any) {
        const adminId = this.getAdminId(req);
        return await this.kycService.rejectDocument(dto, adminId);
    }
}
