import { Controller } from "@nestjs/common";

import { UserService } from "../../services";

@Controller({
    path: "admin/user",
})
export class AdminUserController {
    constructor(private readonly usersService: UserService) {}
}
