import { Inject, Injectable, Logger } from "@nestjs/common";
import { PaymentMethod } from "@prisma/client";

import { FincraBank } from "../providers/fincra.provider";
import { NombaBank } from "../providers/nomba.provider";
import {
    BankInjectionToken,
    BankProvider,
    getBankProviderDisplayName,
    getBankProviderForPaymentMethod,
    getConfiguredInboundPaymentProviders,
    getPaymentMethodForBankProvider,
    resolveInboundPaymentProvider,
} from "../types";

export interface FiatGatewaySummaryRecord {
    provider: string;
    providerKey: BankProvider;
    status: "connected" | "error";
    currency: string;
    availableBalance: number;
    lockedBalance: number;
    ledgerBalance: number;
    error?: string;
}

@Injectable()
export class FiatGatewayRegistryService {
    private readonly logger = new Logger(FiatGatewayRegistryService.name);

    constructor(
        @Inject(BankInjectionToken.FINCRA)
        private readonly fincraService: FincraBank,
        @Inject(BankInjectionToken.NOMBA)
        private readonly nombaService: NombaBank,
    ) {}

    getConfiguredProviders(): BankProvider[] {
        return getConfiguredInboundPaymentProviders();
    }

    resolveProvider(provider?: string | null): BankProvider | null {
        return resolveInboundPaymentProvider(provider);
    }

    getPaymentMethodsForFilter(provider?: string | null): PaymentMethod[] {
        const resolvedProvider = this.resolveProvider(provider);

        if (resolvedProvider) {
            return [getPaymentMethodForBankProvider(resolvedProvider)];
        }

        return this.getConfiguredProviders().map((gatewayProvider) => (
            getPaymentMethodForBankProvider(gatewayProvider)
        ));
    }

    getDisplayNameForPaymentMethod(paymentMethod?: PaymentMethod | null): string {
        const provider = getBankProviderForPaymentMethod(paymentMethod);
        return provider ? getBankProviderDisplayName(provider) : "Unknown";
    }

    getProviderKeyForPaymentMethod(paymentMethod?: PaymentMethod | null): BankProvider | null {
        return getBankProviderForPaymentMethod(paymentMethod);
    }

    async getGatewaySummaries(): Promise<FiatGatewaySummaryRecord[]> {
        const summaries = await Promise.all(
            this.getConfiguredProviders().map((provider) => this.getProviderSummaries(provider)),
        );

        return summaries.flat();
    }

    private async getProviderSummaries(provider: BankProvider): Promise<FiatGatewaySummaryRecord[]> {
        switch (provider) {
            case "fincra":
                return this.getFincraSummaries();
            case "nomba":
            default:
                return this.getNombaSummaries();
        }
    }

    private async getFincraSummaries(): Promise<FiatGatewaySummaryRecord[]> {
        const providerKey: BankProvider = "fincra";

        try {
            const fincraWallets = await this.fincraService.getWallets();
            this.logger.debug(
                `Fincra wallets raw keys: ${fincraWallets?.data?.length ? Object.keys(fincraWallets.data[0] as unknown as Record<string, unknown>).join(", ") : "no data"}`,
            );

            if (!fincraWallets?.data?.length) {
                return [];
            }

            return fincraWallets.data.map((wallet) => {
                const walletData = wallet as unknown as Record<string, unknown>;

                return {
                    provider: getBankProviderDisplayName(providerKey),
                    providerKey,
                    status: "connected" as const,
                    currency: this.resolveCurrency(walletData.currency),
                    availableBalance: Number(walletData.availableBalance ?? walletData.available_balance ?? 0),
                    lockedBalance: Number(walletData.lockedBalance ?? walletData.locked_balance ?? 0),
                    ledgerBalance: Number(walletData.ledgerBalance ?? walletData.ledger_balance ?? 0),
                };
            });
        } catch (error) {
            const providerName = getBankProviderDisplayName(providerKey);
            this.logger.error(`Failed to fetch ${providerName} wallets: ${(error as Error).message}`);

            return [
                {
                    provider: providerName,
                    providerKey,
                    status: "error",
                    currency: "NGN",
                    availableBalance: 0,
                    lockedBalance: 0,
                    ledgerBalance: 0,
                    error: `Unable to connect to ${providerName}`,
                },
            ];
        }
    }

    private async getNombaSummaries(): Promise<FiatGatewaySummaryRecord[]> {
        const providerKey: BankProvider = "nomba";

        try {
            const nombaBalance = await this.nombaService.getAccountBalance();
            const balanceData = (nombaBalance?.data ?? {}) as Record<string, unknown>;
            const balance = Number(balanceData.amount ?? 0);

            return [
                {
                    provider: getBankProviderDisplayName(providerKey),
                    providerKey,
                    status: "connected",
                    currency: this.resolveCurrency(balanceData.currency),
                    availableBalance: balance,
                    lockedBalance: 0,
                    ledgerBalance: balance,
                },
            ];
        } catch (error) {
            const providerName = getBankProviderDisplayName(providerKey);
            this.logger.error(`Failed to fetch ${providerName} balance: ${(error as Error).message}`);

            return [
                {
                    provider: providerName,
                    providerKey,
                    status: "error",
                    currency: "NGN",
                    availableBalance: 0,
                    lockedBalance: 0,
                    ledgerBalance: 0,
                    error: `Unable to connect to ${providerName}`,
                },
            ];
        }
    }

    private resolveCurrency(value: unknown): string {
        if (typeof value === "string" && value.trim()) {
            return value;
        }

        return "NGN";
    }
}