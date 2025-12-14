import { Module, NestModule, MiddlewareConsumer } from "@nestjs/common";
import { SystemSettingsService } from "./services/system-settings.service";
import { FeatureFlagService } from "./services/feature-flag.service";
import { MaintenanceModeService } from "./services/maintenance-mode.service";
import { AdminSystemSettingsController } from "./controllers/v1/admin/system-settings.controller";
import { AdminFeatureFlagController } from "./controllers/v1/admin/feature-flag.controller";
import { MaintenanceMiddleware } from "./middleware/maintenance.middleware";

@Module({
    imports: [],
    controllers: [
        AdminSystemSettingsController,
        AdminFeatureFlagController,
    ],
    providers: [
        SystemSettingsService,
        FeatureFlagService,
        MaintenanceModeService,
    ],
    exports: [
        SystemSettingsService,
        FeatureFlagService,
        MaintenanceModeService,
    ],
})
export class SystemConfigModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
        consumer
            .apply(MaintenanceMiddleware)
            .exclude(
                "admin/(.*)",  // Exclude admin routes
                "health(.*)",   // Exclude health checks
            )
            .forRoutes("*");
    }
}
