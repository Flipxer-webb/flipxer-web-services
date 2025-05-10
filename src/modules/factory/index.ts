import { Module } from "@nestjs/common";
import { IdentityComplianceFactoryModule } from "./identityCompliance";
import { TradingFactoryModule } from "./trading";
import { BankFactoryModule } from "./bank/bank.module";

@Module({
    imports: [
        IdentityComplianceFactoryModule,
        TradingFactoryModule,
        BankFactoryModule,
    ],
})
export class FactoryModule {}
