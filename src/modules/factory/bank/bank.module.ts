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

const nombaProvider: Provider = {
    provide: BankInjectionToken.NOMBA,
    useFactory(prisma: PrismaService) {
        const factory = new BankFactory(prisma);
        return factory.build({ provider: "nomba" });
    },
    inject: [PrismaService],
};

@Global()
@Module({
    providers: [fincraProvider, nombaProvider],
    exports: [fincraProvider, nombaProvider],
})
export class BankFactoryModule { }

