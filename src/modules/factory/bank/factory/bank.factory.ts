import * as t from "../types";
import { fincraOptions } from "@/config";
import { PrismaService } from "@/modules/core/prisma/services";
import { FincraLib } from "@/libs/fincra";
import { FincraBank } from "../providers/fincra.provider";

export class BankFactory<P extends t.BankProvider> {
    constructor(private readonly prisma: PrismaService) {}
    build<T extends P>(options: t.FactoryBuilderOptions<T>) {
        switch (options.provider) {
            case "fincra": {
                const fincra = new FincraLib({
                    baseUrl: fincraOptions.baseUrl,
                    secretKey: fincraOptions.secretKey,
                    publicKey: fincraOptions.publicKey,
                    businessId: fincraOptions.businessId,
                    webhookSecret: fincraOptions.webhookSecret,
                });

                return new FincraBank(fincra, this.prisma);
            }

            default:
                break;
        }
    }
}
