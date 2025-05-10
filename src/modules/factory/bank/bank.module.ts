import { Global, Module, Provider } from "@nestjs/common";
import { BankInjectionToken } from "./types";
import { BankFactory } from "./factory/bank.factory";

const paystackProvider: Provider = {
    provide: BankInjectionToken.PAYSTACK,
    useFactory() {
        const factory = new BankFactory();
        return factory.build({ provider: "paystack" });
    },
};

@Global()
@Module({
    providers: [paystackProvider],
    exports: [paystackProvider],
})
export class BankFactoryModule {}
