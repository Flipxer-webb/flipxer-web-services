import { Inject, Injectable, Logger } from "@nestjs/common";

import { BankInjectionToken } from "../types";
import {
    InitializeInboundPaymentOptions,
    InboundPaymentInitializationResult,
    ResolvedInboundBankAccount,
    ResolveInboundBankAccountOptions,
    VerifiedInboundCheckout,
    VerifyInboundCheckoutOptions,
} from "../types/inbound-payment";
import { FincraBank } from "../providers/fincra.provider";
import { NombaBank } from "../providers/nomba.provider";

@Injectable()
export class InboundFiatPaymentService {
    private readonly logger = new Logger("InboundFiatPaymentService");

    constructor(
        @Inject(BankInjectionToken.FINCRA)
        private readonly fincraService: FincraBank,
        @Inject(BankInjectionToken.NOMBA)
        private readonly nombaService: NombaBank,
    ) {}

    async initializePayment(
        options: InitializeInboundPaymentOptions
    ): Promise<InboundPaymentInitializationResult> {
        const provider = options.provider;
        if (provider !== "fincra" && provider !== "nomba") {
            throw new Error(`Unsupported inbound payment provider: ${String(provider)}`);
        }

        if (provider === "fincra") {
            const result = await this.fincraService.initializePayment(
                options.user,
                options.amount,
                options.callbackUrl
            );

            return {
                provider: "fincra",
                mode: "checkout",
                reference: result.data.reference,
                amount: options.amount,
                expiryAt: this.buildCheckoutExpiryAt(),
                authorizationUrl: result.data.link,
            };
        }

        if (options.modePreference !== "checkout") {
            try {
                const result = await this.nombaService.initializePaymentViaVirtualAccount(
                    options.user,
                    options.amount
                );

                return {
                    provider: "nomba",
                    mode: "virtual_account",
                    reference: result.data.reference,
                    providerAccountReference:
                        result.data.providerAccountReference || result.data.reference,
                    amount: options.amount,
                    expiryAt: result.data.expiryAt,
                    accountNumber: result.data.accountNumber,
                    accountName: result.data.accountName,
                    bankName: result.data.bankName,
                    bankCode: result.data.bankCode,
                };
            } catch (error) {
                if (
                    options.allowCheckoutFallback === false ||
                    !this.isNombaSandboxVirtualAccountLimitError(error)
                ) {
                    throw error;
                }

                this.logger.warn(
                    `Nomba sandbox virtual account cap reached for user ${options.user.id}; falling back to hosted checkout`
                );
            }
        }

        const result = await this.nombaService.initializePayment(
            options.user,
            options.amount,
            options.callbackUrl
        );

        return {
            provider: "nomba",
            mode: "checkout",
            reference: result.data.reference,
            amount: Number(result.data.amount ?? options.amount),
            expiryAt: this.buildCheckoutExpiryAt(),
            authorizationUrl: result.data.link,
        };
    }

    async verifyCheckout(
        options: VerifyInboundCheckoutOptions
    ): Promise<VerifiedInboundCheckout> {
        const provider = options.provider;
        if (provider !== "fincra" && provider !== "nomba") {
            throw new Error(`Unsupported inbound payment provider: ${String(provider)}`);
        }

        const result =
            provider === "fincra"
                ? await this.fincraService.verifyTransaction(options.reference)
                : await this.nombaService.verifyTransaction(options.reference);

        return {
            provider,
            data: result.data,
        };
    }

    async resolveBankAccount(
        options: ResolveInboundBankAccountOptions
    ): Promise<ResolvedInboundBankAccount> {
        const provider = options.provider;
        if (provider !== "fincra" && provider !== "nomba") {
            throw new Error(`Unsupported inbound payment provider: ${String(provider)}`);
        }

        const result =
            provider === "fincra"
                ? await this.fincraService.resolveBankAccount({
                      account_number: options.accountNumber,
                      bank_code: options.bankCode,
                  })
                : await this.nombaService.resolveBankAccount({
                      account_number: options.accountNumber,
                      bank_code: options.bankCode,
                  });

        return {
            provider,
            accountName: result.data.accountName,
            accountNumber: result.data.accountNumber,
            bankCode: result.data.bankCode,
        };
    }

    async cleanupPendingPayment(options: {
        provider: InitializeInboundPaymentOptions["provider"];
        reference: string;
    }): Promise<boolean> {
        const provider = options.provider;
        if (provider !== "fincra" && provider !== "nomba") {
            throw new Error(`Unsupported inbound payment provider: ${String(provider)}`);
        }

        if (provider !== "nomba") {
            return false;
        }

        return this.nombaService.deleteVirtualAccount(options.reference);
    }

    private buildCheckoutExpiryAt(minutes: number = 35): string {
        return new Date(Date.now() + minutes * 60 * 1000).toISOString();
    }

    private isNombaSandboxVirtualAccountLimitError(error: unknown): boolean {
        return (
            error instanceof Error &&
            error.message.includes(
                "Only 2 sandbox virtual accounts are allowed per account holder"
            )
        );
    }
}