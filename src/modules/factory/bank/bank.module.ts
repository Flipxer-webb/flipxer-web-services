import { Global, Module, Provider } from "@nestjs/common";
import { BankInjectionToken } from "./types";
import { BankFactory } from "./factory/bank.factory";
import { PrismaService } from "@/modules/core/prisma/services";

const paystackProvider: Provider = {
    provide: BankInjectionToken.PAYSTACK,
    useFactory(prisma: PrismaService) {
        const factory = new BankFactory(prisma);
        return factory.build({ provider: "paystack" });
    },
    inject: [PrismaService],
};

@Global()
@Module({
    providers: [paystackProvider],
    exports: [paystackProvider],
})
export class BankFactoryModule {}
