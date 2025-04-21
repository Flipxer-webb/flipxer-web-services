import { Module } from "@nestjs/common";
import { AuthModule } from "./auth";
import { AuthorizeModule } from "./authorize";
import { UserModule } from "./user";
import { WebExtension } from "./webExtension";
import { BankDetailsModule } from "./bankDetails";
import { TradingModule } from "./trade";

@Module({
    imports: [
        WebExtension,
        UserModule,
        AuthModule,
        AuthorizeModule,
        BankDetailsModule,
        TradingModule,
    ],
})
export class APIModule {}
