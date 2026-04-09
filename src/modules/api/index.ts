import { Module } from "@nestjs/common";
import { AuthModule } from "./auth";
import { AuthorizeModule } from "./authorize";
import { UserModule } from "./user";
import { WebExtension } from "./webExtension";
import { BankModule } from "./banks";
import { TradingModule } from "./trade";
import { TransactionModule } from "./transactions";
import { SettingModule } from "./settings";
import { NotificationModule } from "./notification/notification.module";
import { SessionModule } from "./session";
import { RbacModule } from "./rbac";
import { AnalyticsModule } from "./analytics";
import { KycModule } from "./kyc";
import { HealthModule } from "./health";
import { OperationsModule } from "./operations";
import { ReportsModule } from "./reports";
import { SystemConfigModule } from "./system-config";
import { AmlModule } from "./aml";

@Module({
    imports: [
        WebExtension,
        UserModule,
        AuthModule,
        AuthorizeModule,
        BankModule,
        TradingModule,
        TransactionModule,
        SettingModule,
        NotificationModule,
        SessionModule,
        RbacModule,
        AnalyticsModule,
        KycModule,
        HealthModule,
        OperationsModule,
        ReportsModule,
        SystemConfigModule,
        AmlModule,
    ],
})
export class APIModule {}
