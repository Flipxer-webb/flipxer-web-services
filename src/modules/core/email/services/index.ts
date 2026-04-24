// src/modules/core/email/services/email.service.ts
import { Injectable, Logger } from "@nestjs/common";
import {
    ISendMailClient,
    SendMailOptions,
    SendMailWithTemplateOptions,
    MailBatchWithTemplateOptions,
} from "../interfaces";

@Injectable()
export class EmailService {
    private readonly logger = new Logger(EmailService.name);
    constructor(private readonly client: ISendMailClient) {}

    async sendMail(options: SendMailOptions): Promise<any> {
        return await this.client.sendMail(options);
    }

    async sendMailWithTemplate(
        options: SendMailWithTemplateOptions
    ): Promise<any> {
        this.logger.log(`Sending email to: ${JSON.stringify(options.to)}, template: ${options.template_key}`);
        try {
            const result = await this.client.sendMailWithTemplate(options);
            this.logger.log(`Email sent successfully: ${JSON.stringify(result)}`);
            return result;
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : JSON.stringify(error);
            const stack = error instanceof Error ? error.stack : undefined;
            this.logger.error(`Failed to send email: ${message}`, stack);
            throw error;
        }
    }

    async sendBatchMail(options: MailBatchWithTemplateOptions): Promise<any> {
        return await this.client.mailBatchWithTemplate(options);
    }
}
