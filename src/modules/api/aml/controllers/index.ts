import {
    Controller,
    Get,
    Post,
    Body,
    Query,
    UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AuthGuard, EnabledAccountGuard } from "@/modules/api/auth/guard";
import { UserTypes, ADMIN_USER_TYPES, Permissions } from "@/modules/api/authorize/decorator";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { PermissionGuard } from "@/modules/api/authorize/guards/permission.guard";
import { PermissionName } from "@/modules/api/authorize/enums/role";
import { AmlService } from "../services";
import {
    CheckAddressDto,
    CheckTransactionDto,
    RecheckDto,
    InvestigateAddressDto,
    GetHistoryDto,
} from "../dtos";

@UseGuards(AuthGuard, RoleGuard, EnabledAccountGuard, PermissionGuard)
@UserTypes(ADMIN_USER_TYPES)
@ApiTags("admin/aml")
@Controller({ path: "admin/aml" })
export class AmlController {
    constructor(private readonly amlService: AmlService) {}

    @ApiOperation({ summary: "Get supported coins/assets for AML checks" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.AML_READ])
    @Get("coins")
    async getSupportedCoins() {
        return await this.amlService.getSupportedCoins();
    }

    @ApiOperation({ summary: "AML check a blockchain address (wallet screening)" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.AML_CHECK])
    @Post("check-address")
    async checkAddress(@Body() dto: CheckAddressDto) {
        return await this.amlService.checkAddress(dto);
    }

    @ApiOperation({ summary: "AML check a blockchain transaction" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.AML_CHECK])
    @Post("check-transaction")
    async checkTransaction(@Body() dto: CheckTransactionDto) {
        return await this.amlService.checkTransaction(dto);
    }

    @ApiOperation({ summary: "Poll result for a pending AML check (async chains)" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.AML_CHECK])
    @Post("recheck")
    async recheck(@Body() dto: RecheckDto) {
        return await this.amlService.recheck(dto);
    }

    @ApiOperation({ summary: "Deep investigation of a blockchain address (expanded analysis)" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.AML_INVESTIGATE])
    @Post("investigate")
    async investigate(@Body() dto: InvestigateAddressDto) {
        return await this.amlService.investigate(dto);
    }

    @ApiOperation({ summary: "Get AML check history" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.AML_READ])
    @Get("history")
    async getHistory(@Query() dto: GetHistoryDto) {
        return await this.amlService.getHistory(dto);
    }
}
