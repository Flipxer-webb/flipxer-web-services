import { forwardRef, Module } from "@nestjs/common";
import { AccountSchedulerService } from "./services/manageAccounts";

@Module({
    imports: [],
    providers: [AccountSchedulerService],
    exports: [AccountSchedulerService],
})
export class SchedulerModule {}
