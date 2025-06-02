import {
    Controller,
    Get,
    Post,
    Body,
    UsePipes,
    ValidationPipe,
    UseGuards,
    Query,
} from "@nestjs/common";
import { UserService } from "../../services";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { AuthGuard } from "@/modules/api/auth/guard";
import {
    GetUserAssetsDto,
    recoveryEmailDto,
} from "../../dtos";
import { User } from "../../decorators";
import { User as UserModel } from "@prisma/client";

@ApiTags("user")
@Controller({
    path: "user",
})
@UseGuards(AuthGuard)
export class UserController {
    constructor(private readonly userService: UserService) {}

    @ApiOperation({ summary: "Get client profile" })
    @ApiBearerAuth("access-token")
    @Get("profile")
    async getProfile(@User() user: UserModel) {
        return await this.userService.getProfile(user);
    }

    @ApiOperation({ summary: "Get user wallet grand balance" })
    @ApiBearerAuth("access-token")
    @Get("wallets/grand-balance")
    async getUserAggregatedWalletBalance(@User() user: UserModel) {
        return await this.userService.getUserAggregatedWalletBalance(user);
    }

    @ApiOperation({ summary: "Get user digital wallet" })
    @ApiBearerAuth("access-token")
    @Get("wallets")
    async getUserWallets(
        @User() user: UserModel,
        @Query() query: GetUserAssetsDto
    ) {
        return await this.userService.getUserWallets(user, query);
    }

    @Post("recovery-email")
    @UsePipes(new ValidationPipe())
    @ApiOperation({
        summary: "add user's email and the actual recovery email",
    })
    @ApiBearerAuth("access-token")
    async verifyRecoveryPin(@Body() dto: recoveryEmailDto) {
        return this.userService.RecoveryEmail(dto);
    }
}
