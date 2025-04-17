import { Module } from "@nestjs/common";
import { AuthModule } from "./auth";
import { AuthorizeModule } from "./authorize";
import { UserModule } from "./user";
import { WebExtension } from "./webExtension";
import { BankDetailsModule } from "./bankDetails";
import { TradeModule } from "./trade";

@Module({
    imports: [
        WebExtension,
        UserModule,
        AuthModule,
        AuthorizeModule,
        BankDetailsModule,
        TradeModule,
    ],
})
export class APIModule {}
