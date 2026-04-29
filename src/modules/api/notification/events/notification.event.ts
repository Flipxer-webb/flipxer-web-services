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
        this.on("login_notification", this.sendLoginNotification.bind(this));
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

    private formatError(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }

        if (typeof error === "string") {
            return error;
        }

        if (
            error === null ||
            error === undefined ||
            typeof error === "number" ||
            typeof error === "boolean" ||
            typeof error === "bigint" ||
            typeof error === "symbol"
        ) {
            return String(error);
        }

        try {
            const serialized = JSON.stringify(error);
            if (serialized) {
                return serialized;
            }
        } catch {
        }

        return "Unserializable error object";
    }

    async sendTransactionNotification(options: t.SendTransactionNotification) {
        try {
            // Validation: Status and Transaction Type
            const validStatuses = [
                "completed",
                "failed",
                "cancelled",
                "reversed",
                "pending",
                "processing",
            ];
            const validTypes = ["deposit", "withdrawal", "swap", "buy", "sell"];

            const normalizedStatus = options.status?.toLowerCase().trim() || '';
            const normalizedType =
                options.transactionType?.toLowerCase().trim() || "";

            // Guard: Invalid status
            if (!validStatuses.includes(normalizedStatus)) {
                this.logger.warn(
                    `[TransactionEmail] Invalid status: ${options.status} for txId=${options.transactionId} recipient=${options.email}`,
                );
                return;
            }

            // Guard: Invalid transaction type
            if (!validTypes.includes(normalizedType)) {
                this.logger.warn(
                    `[TransactionEmail] Invalid type: ${options.transactionType} for txId=${options.transactionId} recipient=${options.email}`,
                );
                return;
            }

            // Guard: Missing required fields
            if (!options.email?.trim()) {
                this.logger.warn(
                    `[TransactionEmail] Missing email for txId=${options.transactionId}`,
                );
                return;
            }

            if (!options.transactionId?.trim()) {
                this.logger.warn(
                    `[TransactionEmail] Missing transactionId for recipient=${options.email}`,
                );
                return;
            }

            const transactionType = normalizedType as t.TransactionType;

            // Base labels per transaction type
            const transactionTypeBase: Record<t.TransactionType, string> = {
                deposit: "Deposit",
                withdrawal: "Withdrawal",
                swap: "Swap",
                buy: "Purchase",
                sell: "Sale",
            };

            // Status suffixes
            const statusSuffix: Record<string, string> = {
                completed: "Completed",
                failed: "Failed",
                cancelled: "Cancelled",
                reversed: "Reversed",
                pending: "Pending",
                processing: "Processing",
            };

            const base = transactionTypeBase[transactionType] || "Transaction";
            const suffix = statusSuffix[normalizedStatus] || "Notification";
            const header = `${base} ${suffix}`;

            const payload = {
                from: { address: cf.mailConfig.senderMail },
                to: [{ email_address: { address: options.email } }],
                template_key: cf.emailTemplateConfig.transaction_notification,
                merge_info: {
                    // Basic info
                    team: cf.COMPANY_NAME,
                    header,
                    notice: options.notice,
                    // Structured transaction details
                    transaction_type: transactionType,
                    transaction_id: options.transactionId,
                    amount: options.amount,
                    currency: options.currency,
                    status: normalizedStatus,
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
            };

            // Log transaction email sending attempt
            this.logger.log(
                `[TransactionEmail] Sending: txId=${options.transactionId} type=${transactionType} status=${normalizedStatus} ` +
                    `amount=${options.amount} ${options.currency} recipient=${options.email}`,
            );

            await this.emailService.sendMailWithTemplate(payload as any);

            // Log successful send
            this.logger.log(
                `[TransactionEmail] Sent successfully: txId=${options.transactionId} type=${transactionType} status=${normalizedStatus} recipient=${options.email}`
            );
        } catch (error) {
            this.logger.error(
                `[TransactionEmail] Failed to send for txId=${
                    options.transactionId
                } recipient=${options.email}: ${
                    this.formatError(error)
                }`
            );
        }
    }

    async sendLoginNotification(options: t.SendLoginNotification) {
        try {
            const templateKey = cf.emailTemplateConfig.login_notification;

            if (!templateKey) {
                this.logger.warn(`Login notification template not configured`);
                return;
            }

            this.logger.log(
                `[LoginNotification] Sending login notification to ${options.email} from IP ${options.ipAddress}`,
            );

            const formattedLoginTime = options.loginTime 
                ? new Date(options.loginTime).toLocaleString()
                : new Date().toLocaleString();

            await this.emailService.sendMailWithTemplate({
                from: { address: cf.mailConfig.senderMail },
                to: [{ email_address: { address: options.email } }],
                template_key: templateKey,
                merge_info: {
                    name: options.name,
                    login_time: formattedLoginTime,
                    ip_address: options.ipAddress,
                    user_agent: options.userAgent || "Unknown",
                    current_year: new Date().getFullYear().toString(),
                    account_security_url: "https://app.flipxer.com/security",
                },
            });

            this.logger.log(
                `[LoginNotification] Sent successfully to ${options.email}`,
            );
        } catch (error) {
            this.logger.error(
                `[LoginNotification] Failed to send to ${options.email}: ${this.formatError(error)}`,
            );
        }
    }

}

