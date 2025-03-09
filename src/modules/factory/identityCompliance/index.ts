import { Module, Provider } from "@nestjs/common";
import { IdentityComplianceFactory } from "./factory";
import { IdentityComplianceInjectionToken } from "./types";
import { identityComplianceConfig } from "@/config";

const dojahService: Provider = {
    provide: IdentityComplianceInjectionToken.DOJAH,
    useFactory() {
        const identityComplianceFactory = new IdentityComplianceFactory(
            identityComplianceConfig
        );
        return identityComplianceFactory.build({ provider: "dojah" });
    },
};

@Module({
    providers: [dojahService],
    exports: [dojahService],
})
export class IdentityComplianceFactoryModule {}
