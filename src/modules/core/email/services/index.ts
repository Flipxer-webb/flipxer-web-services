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
    constructor(private client: ISendMailClient) {}

    async sendMail(options: SendMailOptions): Promise<any> {
        return await this.client.sendMail(options);
    }

    async sendMailWithTemplate(
        options: SendMailWithTemplateOptions
    ): Promise<any> {
        return await this.client.sendMailWithTemplate(options);
    }

    async sendBatchMail(options: MailBatchWithTemplateOptions): Promise<any> {
        return await this.client.mailBatchWithTemplate(options);
    }
}
