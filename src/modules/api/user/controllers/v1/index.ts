import {
    Controller,
    Get,
    Post,
    Body,
    UsePipes,
    ValidationPipe,
    UseGuards,
} from "@nestjs/common";
import { UserService } from "../../services";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { AuthGuard } from "@/modules/api/auth/guard";
import { SendRecoveryPinDto, VerifyRecoveryPinDto } from "../../dtos";

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
    async getProfile() {
        return await this.userService.getProfile();
    }

    @Post("recovery-email/send-pin")
    @UsePipes(new ValidationPipe())
    @ApiOperation({
        summary: "Send a 6-digit recovery PIN to the specified email",
    })
    @ApiBearerAuth("access-token")
    async sendRecoveryPin(@Body() dto: SendRecoveryPinDto) {
        return this.userService.sendRecoveryPin(dto);
    }

    @Post("recovery-email/verify-pin")
    @UsePipes(new ValidationPipe())
    @ApiOperation({
        summary: "Verify the 6-digit PIN and update the recovery email",
    })
    @ApiBearerAuth("access-token")
    async verifyRecoveryPin(@Body() dto: VerifyRecoveryPinDto) {
        return this.userService.verifyRecoveryPin(dto);
    }
}
