import { EventEmitter } from "events";
import { Inject, Injectable, Logger } from "@nestjs/common";

import { EmailService } from "@/modules/core/email/services";
import * as cf from "@/config";
import * as t from "../types/notification.type";

@Injectable()
export class NotificationEvent extends EventEmitter {
    private readonly logger = new Logger(NotificationEvent.name);
    constructor(private emailService: EmailService) {
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
            await this.emailService.sendMailWithTemplate({
                from: { address: cf.mailConfig.senderMail },
                to: [{ email_address: { address: options.email } }],
                template_key: cf.emailTemplateConfig.transaction_notification,
                merge_info: {
                    team: cf.COMPANY_NAME,
                    header: "Transaction Notification",
                    notice: options.notice,
                },
            });
        } catch (error) {
            this.logger.log(error);
        }
    }
}
