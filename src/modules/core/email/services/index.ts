import { Injectable } from "@nestjs/common";
import {
    ISendMailClient,
    MailBatchWithTemplateOptions,
    SendMailOptions,
    SendMailWithTemplateOptions,
} from "../interfaces";

@Injectable()
export class EmailService {
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
