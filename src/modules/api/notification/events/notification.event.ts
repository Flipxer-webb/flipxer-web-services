import { EventEmitter } from "node:events";
import { Injectable, Logger } from "@nestjs/common";

import { EmailService } from "@/modules/core/email/services";
import * as cf from "@/config";
import * as t from "../types/notification.type";

@Injectable()
export class NotificationEvent extends EventEmitter {
    private readonly logger = new Logger(NotificationEvent.name);
    constructor(private readonly emailService: EmailService) {
        super();
        this.on(
            "transaction_notification",
            this.sendTransactionNotification.bind(this)
        );
    }
    emit<K extends keyof t.NotificationEventMap>(
        eventName: K,
        payload: t.NotificationEventMap[K]
    ): boolean {
        return super.emit(eventName, payload);
    }

    on<K extends keyof t.NotificationEventMap>(
        eventName: K,
        listener: (payload: t.NotificationEventMap[K]) => void
    ) {
        return super.on(eventName, listener);
    }

    async sendTransactionNotification(options: t.SendTransactionNotification) {
        try {
            // Base labels per transaction type
            const transactionTypeBase: Record<t.TransactionType, string> = {
                deposit: 'Deposit',
                withdrawal: 'Withdrawal',
                swap: 'Swap',
                buy: 'Purchase',
                sell: 'Sale',
            };

            // Status suffixes
            const statusSuffix: Record<string, string> = {
                completed: 'Completed',
                failed: 'Failed',
                cancelled: 'Cancelled',
                reversed: 'Reversed',
                pending: 'Pending',
                processing: 'Processing',
            };

            const base = transactionTypeBase[options.transactionType] || 'Transaction';
            const suffix = statusSuffix[options.status?.toLowerCase()] || 'Notification';
            const transactionTypeLabels = { [options.transactionType]: `${base} ${suffix}` } as Record<t.TransactionType, string>;

            await this.emailService.sendMailWithTemplate({
                from: { address: cf.mailConfig.senderMail },
                to: [{ email_address: { address: options.email } }],
                template_key: cf.emailTemplateConfig.transaction_notification,
                merge_info: {
                    // Basic info
                    team: cf.COMPANY_NAME,
                    header: transactionTypeLabels[options.transactionType] || "Transaction Notification",
                    notice: options.notice,
                    // Structured transaction details
                    transaction_type: options.transactionType,
                    transaction_id: options.transactionId,
                    amount: options.amount,
                    currency: options.currency,
                    status: options.status,
                    date: options.date,
                    // Blockchain details
                    tx_hash: options.txHash || '',
                    network: options.network || '',
                    wallet_address: options.walletAddress || '',
                    explorer_url: options.explorerUrl || '',
                    recipient: options.recipient || '',
                    // Swap details
                    to_amount: options.toAmount || '',
                    to_currency: options.toCurrency || '',
                    from_amount: options.fromAmount || '',
                    from_currency: options.fromCurrency || '',
                    // Fiat details (buy/sell)
                    fiat_amount: options.fiatAmount || '',
                    bank_name: options.bankName || '',
                    account_number: options.accountNumber || '',
                    // Additional receipt fields
                    order_reference: options.orderReference || '',
                    network_fee: options.networkFee || '',
                    exchange_rate: options.exchangeRate || '',
                },
            });
        } catch (error) {
            this.logger.log(error);
        }
    }
}

