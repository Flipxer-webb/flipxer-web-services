import * as t from "../types";
import { paystackOptions } from "@/config";
import { PaystackLib } from "@/libs/paystack";
import { PaystackBank } from "../providers/paystack.provider";

export class BankFactory<P extends t.BankProvider> {
    build<T extends P>(options: t.FactoryBuilderOptions<T>) {
        switch (options.provider) {
            case "paystack": {
                const paystack = new PaystackLib({
                    baseUrl: paystackOptions.baseUrl,
                    secretKey: paystackOptions.secretKey,
                });

                return new PaystackBank(paystack);
            }

            default:
                break;
        }
    }
}
