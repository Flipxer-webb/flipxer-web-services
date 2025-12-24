import {
    Controller,
    Get,
    Post,
    Patch,
    Delete,
    Body,
    Param,
    ParseIntPipe,
    UseGuards,
} from "@nestjs/common";
import {
    ApiTags,
    ApiOperation,
    ApiBearerAuth,
    ApiBody,
    ApiParam,
} from "@nestjs/swagger";
import {
    PriceAlertService,
    CreatePriceAlertDto,
    UpdatePriceAlertDto,
} from "../../services/price-alert.service";
import {
    AuthGuard,
    CountryBlockGuard,
    EnabledAccountGuard,
} from "@/modules/api/auth/guard";
import { User } from "@/modules/api/user/decorators";
import { User as UserModel } from "@prisma/client";

@ApiTags("price-alerts")
@Controller({
    path: "price-alerts",
})
@UseGuards(CountryBlockGuard, AuthGuard, EnabledAccountGuard)
export class PriceAlertController {
    constructor(private readonly priceAlertService: PriceAlertService) {}

    @ApiOperation({ summary: "Create a new price alert" })
    @ApiBearerAuth("access-token")
    @ApiBody({
        schema: {
            type: "object",
            required: ["currency", "targetPrice", "direction"],
            properties: {
                currency: { type: "string", example: "BTC" },
                targetPrice: { type: "number", example: 50000000 },
                direction: { type: "string", enum: ["ABOVE", "BELOW"] },
                expiresAt: { type: "string", format: "date-time" },
            },
        },
    })
    @Post()
    async createAlert(
        @User() user: UserModel,
        @Body() dto: CreatePriceAlertDto
    ) {
        return await this.priceAlertService.createAlert(user, dto);
    }

    @ApiOperation({ summary: "Get all price alerts for the user" })
    @ApiBearerAuth("access-token")
    @Get()
    async getAlerts(@User() user: UserModel) {
        return await this.priceAlertService.getUserAlerts(user);
    }

    @ApiOperation({ summary: "Get a specific price alert" })
    @ApiBearerAuth("access-token")
    @ApiParam({ name: "id", type: "number" })
    @Get(":id")
    async getAlert(
        @User() user: UserModel,
        @Param("id", ParseIntPipe) id: number
    ) {
        return await this.priceAlertService.getAlert(user, id);
    }

    @ApiOperation({ summary: "Update a price alert" })
    @ApiBearerAuth("access-token")
    @ApiParam({ name: "id", type: "number" })
    @ApiBody({
        schema: {
            type: "object",
            properties: {
                targetPrice: { type: "number" },
                direction: { type: "string", enum: ["ABOVE", "BELOW"] },
                isActive: { type: "boolean" },
                expiresAt: { type: "string", format: "date-time" },
            },
        },
    })
    @Patch(":id")
    async updateAlert(
        @User() user: UserModel,
        @Param("id", ParseIntPipe) id: number,
        @Body() dto: UpdatePriceAlertDto
    ) {
        return await this.priceAlertService.updateAlert(user, id, dto);
    }

    @ApiOperation({ summary: "Delete a price alert" })
    @ApiBearerAuth("access-token")
    @ApiParam({ name: "id", type: "number" })
    @Delete(":id")
    async deleteAlert(
        @User() user: UserModel,
        @Param("id", ParseIntPipe) id: number
    ) {
        return await this.priceAlertService.deleteAlert(user, id);
    }
}
