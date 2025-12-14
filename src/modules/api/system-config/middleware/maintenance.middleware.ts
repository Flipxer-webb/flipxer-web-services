import { Injectable, NestMiddleware, HttpStatus } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { MaintenanceModeService } from "../services/maintenance-mode.service";

@Injectable()
export class MaintenanceMiddleware implements NestMiddleware {
    constructor(private readonly maintenanceService: MaintenanceModeService) {}

    async use(req: Request, res: Response, next: NextFunction) {
        // Check if user is admin (from JWT)
        const isAdmin = (req as any).user?.userType === "ADMIN";
        const ipAddress = req.ip || req.headers["x-forwarded-for"] || "";

        const shouldBypass = await this.maintenanceService.shouldBypass(
            Array.isArray(ipAddress) ? ipAddress[0] : ipAddress,
            isAdmin
        );

        if (shouldBypass) {
            return next();
        }

        const config = await this.maintenanceService.getMaintenanceConfig();

        return res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
            statusCode: HttpStatus.SERVICE_UNAVAILABLE,
            error: "Service Unavailable",
            message: config.message,
            maintenance: {
                enabled: true,
                message: config.message,
                estimatedEndTime: config.estimatedEndTime,
            },
        });
    }
}
