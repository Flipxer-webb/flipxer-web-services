import * as t from "../types";
import { paystackOptions } from "@/config";
import { PaystackLib } from "@/libs/paystack";
import { PaystackBank } from "../providers/paystack.provider";
import { PrismaService } from "@/modules/core/prisma/services";

export class BankFactory<P extends t.BankProvider> {
    constructor(private readonly prisma: PrismaService) {}
    build<T extends P>(options: t.FactoryBuilderOptions<T>) {
        switch (options.provider) {
            case "paystack": {
                const paystack = new PaystackLib({
                    baseUrl: paystackOptions.baseUrl,
                    secretKey: paystackOptions.secretKey,
                });

                return new PaystackBank(paystack, this.prisma);
            }

            default:
                break;
        }
    }
}
