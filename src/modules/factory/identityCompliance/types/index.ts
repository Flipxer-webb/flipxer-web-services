import { DojahService } from "../providers/dojah/services";

export type Provider = "dojah";

export type BuildOptions<T extends Provider> = {
    provider: T;
};

export enum IdentityComplianceInjectionToken {
    DOJAH = "DOJAH",
}

export interface IIdentityComplianceFactory {
    build<T extends Provider>(options: BuildOptions<T>): DojahService;
}
