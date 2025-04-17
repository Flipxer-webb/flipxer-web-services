import { SwaggerResponse, ApiResponse } from "@/utils/api-response-util";
import { Controller } from "@nestjs/common";

import { TradingService } from "../../services";
import {
    ApiTags,
    ApiOperation,
    ApiBearerAuth,
    ApiBody,
    ApiResponse as SwaggerApiResponse,
} from "@nestjs/swagger";
import { AuthGuard } from "@/modules/api/auth/guard";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { User } from "@/modules/api/user";
import { User as UserModel } from "@prisma/client";

@ApiTags("trade")
@Controller({
    path: "trades",
})
export class TradingController {
    constructor(private tradingService: TradingService) {}
}
