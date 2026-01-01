import * as t from "../types";
import { fincraOptions, nombaOptions } from "@/config";
import { PrismaService } from "@/modules/core/prisma/services";
import { FincraLib } from "@/libs/fincra";
import { FincraBank } from "../providers/fincra.provider";
import { NombaLib } from "@/libs/nomba";
import { NombaBank } from "../providers/nomba.provider";

export class BankFactory<P extends t.BankProvider> {
    constructor(private readonly prisma: PrismaService) { }
    build<T extends P>(options: t.FactoryBuilderOptions<T>) {
        switch (options.provider) {
            case "fincra": {
                const fincra = new FincraLib({
                    baseUrl: fincraOptions.baseUrl,
                    secretKey: fincraOptions.secretKey,
                    publicKey: fincraOptions.publicKey,
                    businessId: fincraOptions.businessId,
                    webhookSecret: fincraOptions.webhookSecret,
                    proxyUrl: fincraOptions.proxyUrl, // Proxy for IP whitelisting
                });

                return new FincraBank(fincra, this.prisma);
            }

            case "nomba": {
                const nomba = new NombaLib({
                    baseUrl: nombaOptions.baseUrl,
                    clientId: nombaOptions.clientId,
                    clientSecret: nombaOptions.clientSecret,
                    accountId: nombaOptions.accountId,
                    webhookSecret: nombaOptions.webhookSecret,
                });

                return new NombaBank(nomba, this.prisma);
            }

            default:
                break;
        }
    }
}

