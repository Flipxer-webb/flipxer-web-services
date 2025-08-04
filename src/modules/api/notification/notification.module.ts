import { Global, Module } from "@nestjs/common";
import { AdminNotificationController } from "./controllers/v1/admin.notification.controller";
import { AdminNotificationService } from "./services/admin.notification.service";
import { NotificationController } from "./controllers/v1/notification.controller";
import { NotificationService } from "./services/notification.service";
import { NotificationEvent } from "./events/notification.event";

@Global()
@Module({
    controllers: [AdminNotificationController, NotificationController],
    providers: [
        AdminNotificationService,
        NotificationService,
        NotificationEvent,
    ],
    exports: [NotificationEvent],
})
export class NotificationModule {}
