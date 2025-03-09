import * as t from "../types";
import { DojahService } from "../providers/dojah/services";
import { DojahLib } from "@/libs/dojah";
import { IdentityComplianceConfig } from "@/config";

export class IdentityComplianceFactory implements t.IIdentityComplianceFactory {
    constructor(
        private readonly identityComplianceConfig: IdentityComplianceConfig
    ) {}

    build<T extends t.Provider>(options: t.BuildOptions<T>): DojahService {
        switch (options.provider) {
            case "dojah": {
                const dojahConfig = this.identityComplianceConfig.dojah;
                const dojah = new DojahLib({
                    apiKey: dojahConfig.secret_key,
                    appId: dojahConfig.app_id,
                    baseURL: dojahConfig.baseUrl,
                });

                return new DojahService(dojah);
            }

            //add other providers
            default:
                break;
        }
    }
}
