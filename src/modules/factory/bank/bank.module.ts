import { Global, Module, Provider } from "@nestjs/common";
import { BankInjectionToken } from "./types";
import { BankFactory } from "./factory/bank.factory";
import { PrismaService } from "@/modules/core/prisma/services";

const fincraProvider: Provider = {
    provide: BankInjectionToken.FINCRA,
    useFactory(prisma: PrismaService) {
        const factory = new BankFactory(prisma);
        return factory.build({ provider: "fincra" });
    },
    inject: [PrismaService],
};

@Global()
@Module({
    providers: [fincraProvider],
    exports: [fincraProvider],
})
export class BankFactoryModule {}
