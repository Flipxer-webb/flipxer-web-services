import { Module } from "@nestjs/common";
import { IdentityComplianceFactoryModule } from "./identityCompliance";
import { TradingFactoryModule } from "./trading";

@Module({
    imports: [IdentityComplianceFactoryModule, TradingFactoryModule],
})
export class FactoryModule {}
