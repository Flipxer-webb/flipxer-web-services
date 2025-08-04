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
}
