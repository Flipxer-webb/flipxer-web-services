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
        const payload = this.normalizeTemplatePayload(path, body);
        const response = await fetch(url, {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                Authorization: this.token,
            },
            body: JSON.stringify(payload),
        });

        const data = await this.readResponseBody(response);

        if (!response.ok) {
            const errorMessage = this.getErrorMessage(response, data);
            this.logger.error(`ZeptoMail API error [${response.status}]: ${errorMessage}`);
            throw new Error(errorMessage);
        }

        return data ?? { ok: true, status: response.status };
    }

    private normalizeTemplatePayload(path: string, body: unknown): unknown {
        const isTemplateEndpoint =
            path === "/v1.1/email/template" ||
            path === "/v1.1/email/template/batch";

        if (!isTemplateEndpoint || !body || typeof body !== "object" || Array.isArray(body)) {
            return body;
        }

        const payload = body as Record<string, unknown>;
        const templateKey = typeof payload.template_key === "string" ? payload.template_key : undefined;
        const mailTemplateKey = typeof payload.mail_template_key === "string" ? payload.mail_template_key : undefined;

        if (!templateKey && !mailTemplateKey) {
            return body;
        }

        const { mail_template_key, ...rest } = payload;

        return {
            ...rest,
            ...(templateKey || mailTemplateKey ? { template_key: templateKey ?? mailTemplateKey } : {}),
        };
    }

    private async readResponseBody(response: Response): Promise<unknown> {
        const rawBody = await response.text();
        const trimmedBody = rawBody.trim();

        if (!trimmedBody) {
            return null;
        }

        const contentType = response.headers.get("content-type") ?? "";
        const looksLikeJson =
            contentType.includes("application/json") ||
            trimmedBody.startsWith("{") ||
            trimmedBody.startsWith("[");

        if (!looksLikeJson) {
            return trimmedBody;
        }

        try {
            return JSON.parse(trimmedBody);
        } catch {
            return trimmedBody;
        }
    }

    private getErrorMessage(response: Response, data: unknown): string {
        if (data && typeof data === "object" && "message" in data && typeof data.message === "string") {
            return data.message;
        }

        if (typeof data === "string" && data.trim()) {
            return data;
        }

        return response.statusText || `ZeptoMail request failed with status ${response.status}`;
    }
}
