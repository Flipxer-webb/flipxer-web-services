import { Logger } from "@nestjs/common";
import {
    ISendMailClient,
    MailBatchWithTemplateOptions,
    SendMailOptions,
    SendMailWithTemplateOptions,
} from "../interfaces";

/**
 * Direct HTTP client for ZeptoMail API.
 * Replaces the `zeptomail` npm SDK which has bugs in URL construction
 * and unhandled promise rejections on error responses.
 */
export class ZeptoMailClient implements ISendMailClient {
    private readonly logger = new Logger(ZeptoMailClient.name);
    private readonly baseUrl: string;
    private readonly token: string;

    constructor(options: { url?: string; token: string }) {
        // Use only the origin so env values like
        // https://api.zeptomail.com or https://api.zeptomail.com/v1.1/email
        // both normalize to the same base URL.
        this.baseUrl = this.normalizeBaseUrl(options.url);
        this.token = options.token;
    }

    private normalizeBaseUrl(url?: string): string {
        const trimmedUrl = url?.trim();

        if (!trimmedUrl) {
            throw new Error("ZEPTOMAIL_URL must not be empty");
        }

        const absoluteUrl =
            trimmedUrl.startsWith("http://") || trimmedUrl.startsWith("https://")
                ? trimmedUrl
                : `https://${trimmedUrl}`;

        try {
            return new URL(absoluteUrl).origin;
        } catch {
            throw new Error(`Invalid ZEPTOMAIL_URL: ${trimmedUrl}`);
        }
    }

    async sendMail(options: SendMailOptions): Promise<any> {
        return this.post("/v1.1/email", options);
    }

    async sendMailWithTemplate(
        options: SendMailWithTemplateOptions,
    ): Promise<any> {
        return this.post("/v1.1/email/template", options);
    }

    async mailBatchWithTemplate(
        options: MailBatchWithTemplateOptions,
    ): Promise<any> {
        return this.post("/v1.1/email/template/batch", options);
    }

    private async post(path: string, body: unknown): Promise<any> {
        const url = `${this.baseUrl}${path}`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                Authorization: `Zoho-enczapikey ${this.token}`,
            },
            body: JSON.stringify(body),
        });

        const data = await response.json();

        if (!response.ok) {
            this.logger.error(
                `ZeptoMail API error [${response.status}]: ${JSON.stringify(data)}`,
            );
            throw data;
        }

        return data;
    }
}
