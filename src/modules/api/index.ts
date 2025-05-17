import { Module } from "@nestjs/common";
import { AuthModule } from "./auth";
import { AuthorizeModule } from "./authorize";
import { UserModule } from "./user";
import { WebExtension } from "./webExtension";
import { BankModule } from "./banks";
import { TradingModule } from "./trade";
import { TransactionModule } from "./transactions";
import { SettingModule } from "./settings";

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
    ],
})
export class APIModule {}
