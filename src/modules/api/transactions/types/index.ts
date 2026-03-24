import {
    OrderCategory,
    OrderStatus,
    Prisma,
    TransactionStatus,
    UserType,
} from "@prisma/client";
import { getStreamlinedStatus } from "../../trade/interfaces/trade";

export type TransactionIncludeOptions = Prisma.OrderGetPayload<{
    include: {
        user: { select: { firstName: true; lastName: true; email: true } };
    };
}>;

export const shapeTransaction = (
    t: TransactionIncludeOptions,
    filter = false
) => {
    // For swaps, use fromAmount and fromCurrency as the primary amount
    const isSwap = t.orderCategory === OrderCategory.SWAP;
    const displayAmount = isSwap ? (t?.fromAmount ?? t?.amount) : t?.amount;
    const displayCurrency = isSwap ? (t?.fromCurrency ?? t?.currency) : t?.currency;

    return {
        orderId: t.id,
        userId: t.userId,
        transactionId: t.transactionId,
        name: `${t.user.lastName} ${t.user.firstName}`,
        email: t.user.email,
        walletAddress: t?.recipient,
        transactionType: t.orderCategory,
        amount: displayAmount,
        currency: displayCurrency,
        status: t.status,
        streamLinedStatus: getStreamlinedStatus(
            filter ? t.streamlinedStatus : t.status
        ) as string,
        date: t.createdAt,
        updatedAt: t.updatedAt,
        swap:
            isSwap
                ? {
                    quotationId: t?.quotationId,
                    fromCurrency: t?.fromCurrency,
                    toCurrency: t?.toCurrency,
                    fromAmount: t?.fromAmount,
                    toAmount: t?.toAmount,
                    quoted_price: t?.quoted_price,
                    quoted_currency: t?.quoted_currency,
                    executionPrice: t?.executionPrice,
                    swapExpiresAt: t?.swapExpiresAt,
                }
                : null,
        narration: t?.narration,
        reason: t?.reason,
        transaction_note: t?.transaction_note,
        recipient: t?.recipient,
        fee: t?.fee,
        total: t?.total,
        amountInFiat: t?.amountInFiat,
        rateAtConversion: t?.rateAtConversion,
        totalToReceiveInFiat: t?.totalToReceiveInFiat,
        estimatedProfit: t?.estimatedProfit,
        referenceFiatCurrency: t?.referenceFiatCurrency,
        orderReference: t?.orderReference,
        providerOrderId: t?.providerOrderId,
        sender: t?.sender,
        txHash: t?.blockchain_txid,
        sourceType: t?.sourceType,
        market: t?.market,
        orderType: t?.orderType,
        orderSide: t?.orderSide,
        volume: t?.volume,
        price: t?.price,
        destinationBankName: t?.destinationBankName,
        destinationBankAccountName: t?.destinationBankAccountName,
        destinationBankAccountNumber: t?.destinationBankAccountNumber,
        destinationBankCode: t?.destinationBankCode,
        destinationTag: t?.destinationTag,
        paymentStatus: t?.paymentStatus,
        fulfilled: t?.fulfilled,
        ledgerEntryId: t?.ledgerEntryId,
    };
};

export enum TransactionShortDescription {
    WALLET_FUNDED = "Wallet Funded",
    TRANSFER_FUND = "Transferred Fund",
    BANK_TRANSFER_REFUND = "Failed Bank Transfer Refund",
}

export interface GeneralReportDownload {
    transactionId: string;
    type: OrderCategory;
    userType: UserType;
    name: string;
    email: string;
    amount: string | number;
    currency: string;
    transactionStatus: OrderStatus;
    paymentStatus: TransactionStatus;
    recipient: string;
    fee: number | string;
    date: string;
    destinationBankName?: string;
    destinationBankAccountNumber?: string;
    destinationBankAccountName?: string;
    totalReceiveInFiat?: string;
    fromCurrency: string;
    toCurrency: string;
    toAmount: string;
    quotedCurrency: string;
}

export type GeneralReportCSVField = {
    id: keyof GeneralReportDownload;
    title: string;
};
