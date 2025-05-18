import { SwaggerResponse, ApiResponse } from "@/utils/api-response-util";
import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseIntPipe,
    Post,
    UseGuards,
} from "@nestjs/common";

import { SettingService } from "../../services";
import {
    ApiTags,
    ApiOperation,
    ApiResponse as SwaggerApiResponse,
    ApiBearerAuth,
} from "@nestjs/swagger";
import { AuthGuard, EnabledAccountGuard } from "@/modules/api/auth/guard";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { UserTypes } from "@/modules/api/authorize/decorator";
import { UserType } from "@prisma/client";
import {
    CreateOrUpdateCryptoRateDto,
    CreateOrUpdateCryptoTransactionFeeDto,
} from "../../dtos";

@ApiTags("admin")
@UseGuards(AuthGuard, RoleGuard, EnabledAccountGuard)
@UserTypes([UserType.ADMIN])
@ApiBearerAuth("access-token")
@Controller({
    path: "admin/settings",
})
export class AdminSettingController {
    constructor(private settingService: SettingService) {}

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "get crypto rate list" })
    @Get("crypto/rates")
    async getCryptoRateList() {
        return this.settingService.getCryptoRateList();
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "get crypto transaction fee list" })
    @Get("crypto/transaction-fees")
    async getCryptoTransactionFees() {
        return this.settingService.getCryptoTransactionFeeList();
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "create or update crypto rate" })
    @Post("crypto/rates")
    async createOrUpdateCryptoRate(@Body() dto: CreateOrUpdateCryptoRateDto) {
        return this.settingService.createOrUpdateCryptoRate(dto);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "create or update crypto transaction fee" })
    @Post("crypto/transaction-fees")
    async createOrUpdateCryptoTransactionFee(
        @Body() dto: CreateOrUpdateCryptoTransactionFeeDto
    ) {
        return this.settingService.createOrUpdateCryptoTransactionFee(dto);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "get crypto rate detail" })
    @Get("crypto/rates/:rateId")
    async getCryptoRateDetail(@Param("rateId", ParseIntPipe) rateId: number) {
        return this.settingService.getCryptoRateDetail(rateId);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "get crypto transaction fee detail" })
    @Get("crypto/transaction-fees/:transactionFeeId")
    async getCryptoTransactionFeeDetail(
        @Param("transactionFeeId", ParseIntPipe) transactionFeeId: number
    ) {
        return this.settingService.getCryptoTransactionFeeDetail(
            transactionFeeId
        );
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "delete crypto rate" })
    @Delete("crypto/rates/:rateId")
    async deleteCryptoRate(@Param("rateId", ParseIntPipe) rateId: number) {
        return this.settingService.deleteCryptoRate(rateId);
    }

    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "delete crypto transaction fee" })
    @Delete("crypto/transaction-fees/:transactionFeeId")
    async deleteCryptoTransactionFee(
        @Param("transactionFeeId", ParseIntPipe) transactionFeeId: number
    ) {
        return this.settingService.deleteCryptoTransactionFee(transactionFeeId);
    }
}
