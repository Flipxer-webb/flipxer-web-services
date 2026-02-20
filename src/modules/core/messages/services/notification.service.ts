import { Injectable } from "@nestjs/common";
import * as t from "../types/notification.type";

@Injectable()
export class NotificationMessageService {
    receiveTransaction(options: t.IReceiveTransaction) {
        return `🎉 You just received ${+options.amount} ${options.currency.toUpperCase()} from ${
            options.sender || "a sender"
        }! Transaction ID: ${options.transactionId}.`;
    }

    swapTransactionSuccess(options: t.ISwapTransactionSuccess) {
        return `✅ Swap Successful! You exchanged ${+options.fromAmount} ${options.fromCurrency.toUpperCase()} for ${+options.toAmount} ${options.toCurrency.toUpperCase()}. Transaction ID: ${
            options.transactionId
        }.`;
    }

    sendTransactionSuccess(options: t.ISendTransactionSuccess) {
        return `📤 Your transfer of ${+options.amount} ${options.currency.toUpperCase()} to ${
            options.recipient || "the recipient"
        } has been initiated successfully. Transaction ID: ${
            options.transactionId
        }.`;
    }

    fiatPaymentSuccess(options: t.IFiatPaymentSuccess) {
        return `💵 Payment of ₦${+options.amount} to your bank account (${
            options.bankName
        } - ${options.accountNumber}) was successful. Transaction ID: ${
            options.transactionId
        }.`;
    }

    buyTransactionSuccess(options: t.IBuyTransactionSuccess) {
        return `🛒 Purchase Successful! You bought ${+options.amount} ${options.currency.toUpperCase()}. Your crypto has been added to your wallet. Transaction ID: ${
            options.transactionId
        }.`;
    }

    sellTransactionSuccess(options: t.ISellTransactionSuccess) {
        return `💰 Sale Successful! You sold ${+options.amount} ${options.currency.toUpperCase()} for ₦${+options.fiatAmount}. Funds sent to ${
            options.bankName
        } (${options.accountNumber}). Transaction ID: ${
            options.transactionId
        }.`;
    }

    buyTransactionFailed(options: t.IBuyTransactionFailed) {
        const reason = options.reason ? ` Reason: ${options.reason}.` : "";
        return `❌ Your buy order of ${+options.amount} ${options.currency.toUpperCase()} has failed.${reason} Transaction ID: ${options.transactionId}. Please contact support if you need assistance.`;
    }

    buyTransactionCancelled(options: t.IBuyTransactionCancelled) {
        const reason = options.reason ? ` Reason: ${options.reason}.` : "";
        return `🚫 Your buy order of ${+options.amount} ${options.currency.toUpperCase()} was cancelled.${reason} Transaction ID: ${options.transactionId}.`;
    }

    sellTransactionFailed(options: t.ISellTransactionFailed) {
        const reason = options.reason ? ` Reason: ${options.reason}.` : "";
        return `❌ Your sell order of ${+options.amount} ${options.currency.toUpperCase()} has failed.${reason} Transaction ID: ${options.transactionId}. Your funds have been refunded.`;
    }

    swapTransactionFailed(options: t.ISwapTransactionFailed) {
        const reason = options.reason ? ` Reason: ${options.reason}.` : "";
        return `❌ Your swap of ${+options.fromAmount} ${options.fromCurrency.toUpperCase()} to ${options.toCurrency.toUpperCase()} has failed.${reason} Transaction ID: ${options.transactionId}. Your funds have been refunded.`;
    }

    sendTransactionQueued(options: t.ISendTransactionQueued) {
        return `⏳ Your send of ${+options.amount} ${options.currency.toUpperCase()} is being processed. This may take a few minutes. Transaction ID: ${options.transactionId}.`;
    }

    receiveTransactionFailed(options: t.IReceiveTransactionFailed) {
        return `❌ Your deposit of ${+options.amount} ${options.currency.toUpperCase()} has failed. Transaction ID: ${options.transactionId}. Please contact support if you need assistance.`;
    }
}
