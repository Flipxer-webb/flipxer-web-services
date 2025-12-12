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
    ],
})
export class APIModule {}
