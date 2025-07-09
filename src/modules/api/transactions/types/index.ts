import { OrderCategory, Prisma } from "@prisma/client";
import { getStreamlinedStatus } from "../../trade/interfaces/trade";

export type TransactionIncludeOptions = Prisma.OrderGetPayload<{
    include: {
        user: { select: { firstName: true; lastName: true } };
    };
}>;

export const shapeTransaction = (
    t: TransactionIncludeOptions,
    filter = false
) => {
    return {
        transactionId: t.transactionId,
        name: `${t.user.lastName} ${t.user.firstName}`,
        walletAddress: t?.recipient,
        transactionType: t.orderCategory,
        amount: t?.amount,
        currency: t?.currency,
        status: t.status,
        streamLinedStatus: getStreamlinedStatus(
            filter ? t.streamlinedStatus : t.status
        ) as string,
        date: t.createdAt,
        swap:
            t.orderCategory === OrderCategory.SWAP
                ? {
                      quotationId: t?.quotationId,
                      fromCurrency: t?.fromCurrency,
                      toCurrency: t?.toCurrency,
                      fromAmount: t?.fromAmount,
                      toAmount: t?.toAmount,
                      quoted_price: t?.quoted_price,
                      quoted_currency: t?.quoted_currency,
                      executionPrice: t?.executionPrice,
                  }
                : null,
        narration: t?.narration,
        reason: t?.reason,
        transaction_note: t?.transaction_note,
        recipient: t?.recipient,
        fee: t?.fee,
        total: t?.total,
    };
};

export enum TransactionShortDescription {
    WALLET_FUNDED = "Wallet Funded",
    TRANSFER_FUND = "Transferred Fund",
    BANK_TRANSFER_REFUND = "Failed Bank Transfer Refund",
}
