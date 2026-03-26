import {
    Controller,
    Post,
    Get,
    Patch,
    Delete,
    Body,
    Param,
    UseGuards,
    ValidationPipe,
    HttpCode,
    HttpStatus,
} from "@nestjs/common";
import {
    ApiTags,
    ApiOperation,
    ApiBearerAuth,
    ApiParam,
} from "@nestjs/swagger";
import { AuthGuard } from "../../auth/guard";
import { RateLimiterGuard, RateLimit } from "@/modules/core/rate-limit/guards/rate-limiter.guard";
import { BankService } from "../services";
import {
    CreateBankDetailDto,
    UpdateBankDetailDto,
    BankDetailResponseDto,
    VerifyBankAccountDto,
} from "../dtos";
import { ApiResponse } from "@/utils";
import { User } from "@/modules/api/user";
import { User as UserModel } from "@prisma/client";

@ApiTags("Bank")
@Controller("banks")
export class BankController {
    constructor(private readonly bankService: BankService) { }

    @Get("list")
    async getBankList() {
        return await this.bankService.getListOfBanks();
    }

    @HttpCode(HttpStatus.OK)
    @UseGuards(RateLimiterGuard)
    @RateLimit({ limit: 10, windowSeconds: 60, errorMessage: "Too many account verification attempts. Please try again later." })
    @Post("verify-account")
    async verifyBankAccount(@Body() dto: VerifyBankAccountDto) {
        return await this.bankService.verifyBankAccount(dto);
    }

    @UseGuards(AuthGuard)
    @ApiBearerAuth("access-token")
    @HttpCode(HttpStatus.OK)
    @Post("nomba/checkout")
    @ApiOperation({
        summary: "Initialize Nomba checkout for payment",
        description: "Creates a Nomba checkout order and returns a payment link.",
    })
    async initializeNombaCheckout(
        @User() user: UserModel,
        @Body() body: { amount: number; callbackUrl?: string }
    ) {
        return await this.bankService.initializeNombaCheckout(
            user.id,
            body.amount,
            body.callbackUrl
        );
    }

    @UseGuards(AuthGuard)
    @ApiBearerAuth("access-token")
    @HttpCode(HttpStatus.OK)
    @Get("nomba/checkout/:reference")
    @ApiOperation({
        summary: "Verify Nomba checkout status",
        description: "Returns the status of a Nomba checkout order.",
    })
    @ApiParam({
        name: "reference",
        description: "Order reference from checkout creation",
        type: String,
    })
    async verifyNombaCheckout(
        @User() user: UserModel,
        @Param("reference") reference: string
    ) {
        return await this.bankService.verifyNombaCheckout(reference);
    }

    @UseGuards(AuthGuard)
    @ApiBearerAuth("access-token")
    @Post()
    @ApiOperation({
        summary: "Add a new bank detail for the authenticated user",
        description: "Creates a bank detail for the authenticated user.",
    })
    async create(
        @User() user: UserModel,
        @Body(ValidationPipe) createBankDetailDto: CreateBankDetailDto
    ): Promise<ApiResponse<BankDetailResponseDto>> {
        return this.bankService.create(user.id, createBankDetailDto);
    }

    @UseGuards(AuthGuard)
    @ApiBearerAuth("access-token")
    @Get()
    @ApiOperation({
        summary: "Get all bank details for the authenticated user",
    })
    async findAll(
        @User() user: UserModel
    ): Promise<ApiResponse<BankDetailResponseDto[]>> {
        return this.bankService.findAll(user.id);
    }

    @Get(":id")
    @ApiOperation({
        summary: "Get a specific bank detail by ID for the authenticated user",
    })
    @ApiParam({
        name: "id",
        description: "ID of the bank detail to retrieve",
        type: Number,
        example: 1,
    })
    @UseGuards(AuthGuard)
    @ApiBearerAuth("access-token")
    async findOne(
        @User() user: UserModel,
        @Param("id") id: string
    ): Promise<ApiResponse<BankDetailResponseDto>> {
        return this.bankService.findOne(user.id, parseInt(id));
    }

    @Patch(":id")
    @ApiOperation({
        summary:
            "Update a specific bank detail by ID for the authenticated user",
    })
    @ApiParam({
        name: "id",
        description: "ID of the bank detail to update",
        type: Number,
        example: 1,
    })
    @UseGuards(AuthGuard)
    @ApiBearerAuth("access-token")
    async update(
        @User() user: UserModel,
        @Param("id") id: string,
        @Body(ValidationPipe) updateBankDetailDto: UpdateBankDetailDto
    ): Promise<ApiResponse<BankDetailResponseDto>> {
        return this.bankService.update(
            user.id,
            parseInt(id),
            updateBankDetailDto
        );
    }

    @Delete(":id")
    @ApiOperation({
        summary:
            "Delete a specific bank detail by ID for the authenticated user",
    })
    @ApiParam({
        name: "id",
        description: "ID of the bank detail to delete",
        type: Number,
        example: 1,
    })
    @UseGuards(AuthGuard)
    @ApiBearerAuth("access-token")
    async remove(
        @User() user: UserModel,
        @Param("id") id: string
    ): Promise<ApiResponse<null>> {
        return this.bankService.remove(user.id, parseInt(id));
    }
}
