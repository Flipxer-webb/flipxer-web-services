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
            // Remap template_key → mail_template_key for ZeptoMail API compatibility
            const { template_key, ...rest } = options;
            const mapped = template_key
                ? { ...rest, mail_template_key: template_key }
                : rest;
            const result = await this.client.sendMailWithTemplate(mapped as any);
            this.logger.log(`Email sent successfully: ${JSON.stringify(result)}`);
            return result;
        } catch (error) {
            this.logger.error(`Failed to send email: ${error.message}`, error.stack);
            throw error;
        }
    }

    async sendBatchMail(options: MailBatchWithTemplateOptions): Promise<any> {
        // Remap template_key → mail_template_key for ZeptoMail API compatibility
        const { template_key, ...rest } = options;
        const mapped = template_key
            ? { ...rest, mail_template_key: template_key }
            : rest;
        return await this.client.mailBatchWithTemplate(mapped as any);
    }
}
