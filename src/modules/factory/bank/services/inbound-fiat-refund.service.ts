import { Inject, Injectable } from "@nestjs/common";

import { BankInjectionToken } from "../types";
import {
    RefundTransferExecutionResult,
    RefundTransferOptions,
    VerifiedRefundTransfer,
    VerifyRefundTransferOptions,
} from "../types/refund-payment";
import { FincraBank } from "../providers/fincra.provider";
import { NombaBank } from "../providers/nomba.provider";

@Injectable()
export class InboundFiatRefundService {
    constructor(
        @Inject(BankInjectionToken.FINCRA)
        private readonly fincraService: FincraBank,
        @Inject(BankInjectionToken.NOMBA)
        private readonly nombaService: NombaBank,
    ) {}

    async initializeRefundTransfer(
        options: RefundTransferOptions,
    ): Promise<RefundTransferExecutionResult> {
        if (options.provider === "fincra") {
            return this.fincraService.initializeRefundTransfer(options);
        }

        if (options.provider === "nomba") {
            return this.nombaService.initializeRefundTransfer(options);
        }

        throw new Error(`Unsupported refund provider: ${String(options.provider)}`);
    }

    async verifyRefundTransfer(
        options: VerifyRefundTransferOptions,
    ): Promise<VerifiedRefundTransfer> {
        if (options.provider === "fincra") {
            const result = await this.fincraService.verifyRefundTransferStatus(
                options.reference,
            );
            return {
                provider: "fincra",
                status: this.normalizeVerifiedStatus(result.status),
                data: result.data,
            };
        }

        if (options.provider === "nomba") {
            const result = await this.nombaService.verifyRefundTransferStatus(
                options.reference,
                options.externalReference,
                options.providerReference,
            );
            return {
                provider: "nomba",
                status: this.normalizeVerifiedStatus(result.status),
                data: result.data,
            };
        }

        throw new Error(`Unsupported refund provider: ${String(options.provider)}`);
    }

    async resolveBankCodeByName(options: {
        provider: RefundTransferOptions["provider"];
        bankName?: string | null;
    }): Promise<string | null> {
        const normalizedBankName = this.normalizeBankName(options.bankName);
        if (!normalizedBankName) {
            return null;
        }

        const providerBanks =
            options.provider === "fincra"
                ? (await this.fincraService.getBanks()).data
                : (await this.nombaService.getBanks()).data;
        const banks: Array<{ name?: string; code?: string }> = providerBanks;

        const match = banks.find((bank: { name?: string; code?: string }) => {
            return this.normalizeBankName(bank.name) === normalizedBankName;
        });

        return match?.code || null;
    }

    private normalizeBankName(value?: string | null): string | null {
        const normalized = value
            ?.trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .replace(/\s+/g, " ")
            .trim();

        return normalized || null;
    }

    private normalizeVerifiedStatus(
        status: string,
    ): VerifiedRefundTransfer["status"] {
        if (status === "success" || status === "failed" || status === "pending") {
            return status;
        }

        return "pending";
    }
}