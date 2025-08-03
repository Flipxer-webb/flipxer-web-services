import { Global, Module } from "@nestjs/common";
import { NotificationMessageService } from "./services/notification.service";

@Global()
@Module({
    providers: [NotificationMessageService],
    exports: [NotificationMessageService],
})
export class MessageModule {}
