import { PaymentMethod } from "@prisma/client";

import type { BankProvider } from "./index";

export type InboundPaymentProvider = BankProvider;

export interface InboundPaymentUser {
    id: number;
    firstName: string;
    lastName: string;
    email: string;
    phoneNumber?: string | null;
}

export type InboundPaymentMode = "checkout" | "virtual_account";

export interface InitializeInboundPaymentOptions {
    provider: InboundPaymentProvider;
    user: InboundPaymentUser;
    amount: number;
    callbackUrl?: string;
    modePreference?: InboundPaymentMode;
    allowCheckoutFallback?: boolean;
}

export type InboundPaymentInitializationResult =
    | {
          provider: InboundPaymentProvider;
          mode: "checkout";
          reference: string;
          amount: number;
          expiryAt: string;
          authorizationUrl: string;
      }
    | {
          provider: InboundPaymentProvider;
          mode: "virtual_account";
          reference: string;
          providerAccountReference: string;
          amount: number;
          expiryAt: string;
          accountNumber: string;
          accountName: string;
          bankName: string;
          bankCode: string;
      };

export interface ResolveInboundBankAccountOptions {
    provider: InboundPaymentProvider;
    bankCode: string;
    accountNumber: string;
}

export interface ResolvedInboundBankAccount {
    provider: InboundPaymentProvider;
    accountName: string;
    accountNumber: string;
    bankCode?: string;
}

export interface VerifyInboundCheckoutOptions {
    provider: InboundPaymentProvider;
    reference: string;
}

export interface VerifiedInboundCheckout {
    provider: InboundPaymentProvider;
    data: any;
}

export function getPaymentMethodForBankProvider(
    provider: InboundPaymentProvider
): PaymentMethod {
    switch (provider) {
        case "fincra":
            return PaymentMethod.FINCRA;
        case "nomba":
        default:
            return PaymentMethod.NOMBA;
    }
}

export function getBankProviderForPaymentMethod(
    paymentMethod?: PaymentMethod | null
): InboundPaymentProvider | null {
    switch (paymentMethod) {
        case PaymentMethod.FINCRA:
            return "fincra";
        case PaymentMethod.NOMBA:
            return "nomba";
        default:
            return null;
    }
}

export function getBankProviderDisplayName(
    provider: InboundPaymentProvider
): string {
    switch (provider) {
        case "fincra":
            return "Fincra";
        case "nomba":
        default:
            return "Nomba";
    }
}

export function getConfiguredInboundPaymentProviders(): InboundPaymentProvider[] {
    return ["fincra", "nomba"];
}

export function resolveInboundPaymentProvider(
    provider?: string | null
): InboundPaymentProvider | null {
    const normalizedProvider = provider?.trim().toLowerCase();

    if (normalizedProvider === "fincra" || normalizedProvider === "nomba") {
        return normalizedProvider;
    }

    return null;
}