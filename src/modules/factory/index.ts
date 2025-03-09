import { Module } from "@nestjs/common";
import { IdentityComplianceFactoryModule } from "./identityCompliance";

@Module({
    imports: [IdentityComplianceFactoryModule],
})
export class FactoryModule {}
