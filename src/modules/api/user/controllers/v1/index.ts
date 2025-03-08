import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { UserService } from "../../services";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

@ApiTags("user")
@Controller({
    path: "user",
})
export class UserController {
    constructor(private readonly userService: UserService) {}

    @ApiOperation({ summary: "get client profile" })
    @ApiBearerAuth("access-token")
    @Get("profile")
    async getProfile() {
        return await this.userService.getProfile();
    }
}
