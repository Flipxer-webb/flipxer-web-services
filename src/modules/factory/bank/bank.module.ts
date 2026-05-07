import { Global, Module, Provider } from "@nestjs/common";
import { BankInjectionToken } from "./types";
import { BankFactory } from "./factory/bank.factory";
import { PrismaService } from "@/modules/core/prisma/services";
import { FiatGatewayRegistryService } from "./services/fiat-gateway-registry.service";
import { InboundFiatPaymentService } from "./services/inbound-fiat-payment.service";
import { InboundFiatRefundService } from "./services/inbound-fiat-refund.service";
import { PaymentWebhookAdapterService } from "./services/payment-webhook-adapter.service";

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
    providers: [
        fincraProvider,
        nombaProvider,
        InboundFiatPaymentService,
        InboundFiatRefundService,
        FiatGatewayRegistryService,
        PaymentWebhookAdapterService,
    ],
    exports: [
        fincraProvider,
        nombaProvider,
        InboundFiatPaymentService,
        InboundFiatRefundService,
        FiatGatewayRegistryService,
        PaymentWebhookAdapterService,
    ],
})
export class BankFactoryModule { }

