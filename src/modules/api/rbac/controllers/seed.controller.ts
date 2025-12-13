import { Controller, Post, Body } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { RbacService } from "../services";

@ApiTags("admin/rbac/seed")
@Controller({ path: "admin/rbac" })
export class RbacSeedController {
    constructor(private readonly rbacService: RbacService) {}

    @ApiOperation({ summary: "Seed permissions from defined constants (requires seed key)" })
    @Post("permissions/seed")
    async seedPermissions(@Body() body: { seedKey?: string }) {
        // Simple protection: require a seed key from environment
        const expectedKey = process.env.SEED_KEY || "flipxer-seed-2024";
        if (body.seedKey !== expectedKey) {
            return { success: false, message: "Invalid seed key" };
        }
        await this.rbacService.seedPermissions();
        return await this.rbacService.getAllPermissions();
    }
}
