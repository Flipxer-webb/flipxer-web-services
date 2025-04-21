import {
    Controller,
    Post,
    Get,
    Patch,
    Delete,
    Body,
    Param,
    UseGuards,
    HttpStatus,
    Req,
} from "@nestjs/common";
import {
    ApiTags,
    ApiOperation,
    ApiResponse,
    ApiBearerAuth,
    ApiBody,
    ApiParam,
} from "@nestjs/swagger";
import { Request } from "express"; // Import Request from express
import { AuthGuard } from "../../auth/guard"; // Adjust path as needed
import { BankDetailsService } from "../services";
import {
    CreateBankDetailDto,
    UpdateBankDetailDto,
    BankDetailResponseDto,
} from "../dtos";

// Extend the Express Request interface to include the user property
interface AuthenticatedRequest extends Request {
    user: {
        id: number; // Adjust this based on your JWT payload structure
        [key: string]: any; // Allow additional properties if needed
    };
}

@ApiTags("Bank Details")
@Controller("bank-details")
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class BankDetailsController {
    constructor(private readonly bankDetailsService: BankDetailsService) {}

    @Post(":id")
    @ApiOperation({
        summary: "Add a new bank detail for a specific user",
        description:
            "Creates a bank detail for the user specified by the ID in the path.",
    })
    @ApiParam({
        name: "id",
        description: "User ID to associate the bank detail with",
        required: true,
        type: Number,
        example: 1,
    })
    @ApiBody({
        type: CreateBankDetailDto,
        description: "Bank detail data to create",
    })
    @ApiResponse({
        status: HttpStatus.CREATED,
        description: "Bank detail created successfully",
        type: BankDetailResponseDto,
    })
    @ApiResponse({
        status: HttpStatus.FORBIDDEN,
        description: "Forbidden: Only INDIVIDUAL and BUSINESS users allowed",
    })
    async create(
        @Param("id") id: string,
        @Body() createBankDetailDto: CreateBankDetailDto
    ) {
        return this.bankDetailsService.create(
            parseInt(id),
            createBankDetailDto
        );
    }

    @Get()
    @ApiOperation({
        summary: "Get all bank details for the authenticated user",
    })
    @ApiResponse({
        status: HttpStatus.OK,
        description: "List of bank details",
        type: [BankDetailResponseDto],
    })
    @ApiResponse({
        status: HttpStatus.NOT_FOUND,
        description: "User not found",
    })
    async findAll(@Req() req: AuthenticatedRequest) {
        return this.bankDetailsService.findAll(req.user.id);
    }

    @Get(":id")
    @ApiOperation({
        summary: "Get a specific bank detail by ID for the authenticated user",
    })
    @ApiResponse({
        status: HttpStatus.OK,
        description: "Bank detail retrieved",
        type: BankDetailResponseDto,
    })
    @ApiResponse({
        status: HttpStatus.NOT_FOUND,
        description: "Bank detail not found or does not belong to user",
    })
    async findOne(@Req() req: AuthenticatedRequest, @Param("id") id: string) {
        return this.bankDetailsService.findOne(req.user.id, parseInt(id));
    }

    @Patch(":id")
    @ApiOperation({
        summary:
            "Update a specific bank detail by ID for the authenticated user",
    })
    @ApiResponse({
        status: HttpStatus.OK,
        description: "Bank detail updated successfully",
        type: BankDetailResponseDto,
    })
    @ApiResponse({
        status: HttpStatus.NOT_FOUND,
        description: "Bank detail not found or does not belong to user",
    })
    async update(
        @Req() req: AuthenticatedRequest,
        @Param("id") id: string,
        @Body() updateBankDetailDto: UpdateBankDetailDto
    ) {
        return this.bankDetailsService.update(
            req.user.id,
            parseInt(id),
            updateBankDetailDto
        );
    }

    @Delete(":id")
    @ApiOperation({
        summary:
            "Delete a specific bank detail by ID for the authenticated user",
    })
    @ApiResponse({
        status: HttpStatus.NO_CONTENT,
        description: "Bank detail deleted successfully",
    })
    @ApiResponse({
        status: HttpStatus.NOT_FOUND,
        description: "Bank detail not found or does not belong to user",
    })
    async remove(@Req() req: AuthenticatedRequest, @Param("id") id: string) {
        await this.bankDetailsService.remove(req.user.id, parseInt(id));
    }
}
