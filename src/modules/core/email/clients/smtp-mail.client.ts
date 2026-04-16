import nodemailer, { Transporter } from "nodemailer";
import { Logger } from "@nestjs/common";
import * as fs from "node:fs";
import * as path from "node:path";

import { emailTemplateConfig } from "@/config";
import {
    ISendMailClient,
    MailBatchWithTemplateOptions,
    SendMailOptions,
    SendMailWithTemplateOptions,
} from "../interfaces";

type MailAddress = {
    address: string;
    name?: string;
};

type MailRecipient = {
    email_address: MailAddress;
    merge_info?: Record<string, unknown>;
};

export class SmtpMailClient implements ISendMailClient {
    private readonly logger = new Logger(SmtpMailClient.name);

    constructor(
        private readonly transporter: Transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST ?? "mailhog",
            port: Number.parseInt(process.env.SMTP_PORT ?? "1025", 10),
            secure: process.env.SMTP_SECURE === "true",
            auth:
                process.env.SMTP_USER && process.env.SMTP_PASS
                    ? {
                          user: process.env.SMTP_USER,
                          pass: process.env.SMTP_PASS,
                      }
                    : undefined,
        })
    ) {}

    async sendMail(options: SendMailOptions): Promise<unknown> {
        return await this.transporter.sendMail(this.buildSendMailPayload(options));
    }

    async sendMailWithTemplate(
        options: SendMailWithTemplateOptions
    ): Promise<unknown> {
        const templateKey = options.template_key?.trim();
        const templateName = this.resolveTemplateName(options);
        const templateDisplayName = this.humanizeTemplateName(templateName);
        const mergeInfo = this.mergeRecipientData(
            options.to as MailRecipient[] | undefined,
            options.merge_info
        );

        this.logger.log(
            `Sending local SMTP template preview for ${templateName}`
        );

        return await this.transporter.sendMail({
            from: this.formatAddress(options.from),
            to: this.formatRecipients(options.to as MailRecipient[] | undefined),
            cc: this.formatRecipients(options.cc as MailRecipient[] | undefined),
            bcc: this.formatRecipients(options.bcc as MailRecipient[] | undefined),
            replyTo: this.formatReplyTo(options.reply_to),
            subject: `[Local SMTP] ${templateDisplayName}`,
            text: this.buildTemplateText(
                templateDisplayName,
                templateKey,
                mergeInfo
            ),
            html: this.buildTemplateHtml(
                templateDisplayName,
                templateKey,
                mergeInfo
            ),
            headers: this.buildHeaders(options.client_reference, options.mime_headers),
        });
    }

    async mailBatchWithTemplate(
        options: MailBatchWithTemplateOptions
    ): Promise<unknown> {
        const recipients = (options.to as MailRecipient[] | undefined) ?? [];
        const results = await Promise.all(
            recipients.map(async (recipient) => {
                return await this.sendMailWithTemplate({
                    ...options,
                    to: [recipient] as never,
                    merge_info: {
                        ...(options.merge_info ?? {}),
                        ...(recipient.merge_info ?? {}),
                    },
                });
            })
        );

        return {
            total: results.length,
            accepted: recipients.map((recipient) => recipient.email_address.address),
            results,
        };
    }

    private buildSendMailPayload(options: SendMailOptions) {
        return {
            from: this.formatAddress(options.from),
            to: this.formatRecipients(options.to as MailRecipient[] | undefined),
            cc: this.formatRecipients(options.cc as MailRecipient[] | undefined),
            bcc: this.formatRecipients(options.bcc as MailRecipient[] | undefined),
            replyTo: this.formatReplyTo(options.reply_to),
            subject: options.subject,
            text: options.textbody,
            html: options.htmlbody,
            headers: this.buildHeaders(options.client_reference, options.mime_headers),
            attachments: [
                ...this.buildAttachments(options.attachments),
                ...this.buildInlineImages(options.inline_images),
            ],
        };
    }

    private buildHeaders(
        clientReference?: string,
        mimeHeaders?: Record<string, string>
    ) {
        return {
            ...(mimeHeaders ?? {}),
            ...(clientReference
                ? { "X-Client-Reference": clientReference }
                : {}),
        };
    }

    private buildAttachments(
        attachments?: Array<{
            content?: string;
            mime_type: string;
            name: string;
        }>
    ) {
        return (attachments ?? [])
            .filter((attachment) => Boolean(attachment.content))
            .map((attachment) => ({
                filename: attachment.name,
                content: Buffer.from(attachment.content!, "base64"),
                contentType: attachment.mime_type,
            }));
    }

    private buildInlineImages(
        inlineImages?: Array<{
            mime_type: string;
            content?: string;
            cid: string;
        }>
    ) {
        return (inlineImages ?? [])
            .filter((inlineImage) => Boolean(inlineImage.content))
            .map((inlineImage, index) => ({
                filename: `inline-${index}`,
                content: Buffer.from(inlineImage.content!, "base64"),
                contentType: inlineImage.mime_type,
                cid: inlineImage.cid,
            }));
    }

    private mergeRecipientData(
        recipients?: MailRecipient[],
        mergeInfo?: Record<string, unknown>
    ) {
        return (recipients ?? []).reduce<Record<string, unknown>>(
            (accumulator, recipient) => ({
                ...accumulator,
                ...(recipient.merge_info ?? {}),
            }),
            { ...(mergeInfo ?? {}) }
        );
    }

    private buildTemplateText(
        templateName: string,
        templateKey: string | undefined,
        mergeInfo: Record<string, unknown>
    ) {
        const serializedMergeInfo = Object.entries(mergeInfo)
            .map(([key, value]) => `${key}: ${this.serializeValue(value)}`)
            .join("\n");

        return [
            `Local SMTP preview for template: ${templateName}`,
            ...(templateKey ? [`Template key: ${templateKey}`] : []),
            "",
            serializedMergeInfo || "No merge fields provided.",
        ].join("\n");
    }

    private buildTemplateHtml(
        templateName: string,
        templateKey: string | undefined,
        mergeInfo: Record<string, unknown>
    ) {
        const rendered = this.tryRenderLocalTemplate(templateName, mergeInfo);
        if (rendered) {
            return rendered;
        }

        // Fallback: styled merge-field table
        const rows = Object.entries(mergeInfo)
            .map(
                ([key, value]) =>
                    `<tr><td style="padding:8px;border:1px solid #d0d5dd;font-weight:600;vertical-align:top;">${this.escapeHtml(
                        key
                    )}</td><td style="padding:8px;border:1px solid #d0d5dd;">${this.escapeHtml(
                        this.serializeValue(value)
                    )}</td></tr>`
            )
            .join("");

        return [
            '<div style="font-family:Arial,sans-serif;padding:24px;color:#101828;">',
            `<h1 style="font-size:20px;margin:0 0 16px;">Local SMTP preview</h1>`,
            `<p style="margin:0 0 16px;">Template: <strong>${this.escapeHtml(
                templateName
            )}</strong></p>`,
            templateKey
                ? `<p style="margin:0 0 16px;">Template key: <strong>${this.escapeHtml(
                      templateKey
                  )}</strong></p>`
                : "",
            rows
                ? `<table style="border-collapse:collapse;width:100%;">${rows}</table>`
                : '<p style="margin:0;">No merge fields provided.</p>',
            "</div>",
        ].join("");
    }

    private tryRenderLocalTemplate(
        templateName: string,
        mergeInfo: Record<string, unknown>
    ): string | null {
        // Convert template name to filename: e.g. "verify_account" → "verify-account.html"
        const fileName = templateName.replaceAll("_", "-").toLowerCase() + ".html";
        const templatePath = path.resolve(
            __dirname,
            "../../../../../email-templates",
            fileName
        );

        try {
            if (!fs.existsSync(templatePath)) {
                return null;
            }
            let html = fs.readFileSync(templatePath, "utf-8");
            // Replace {{variable}} placeholders with merge field values
            html = html.replaceAll(/\{\{(\w+)\}\}/g, (_, key: string) => {
                const value = mergeInfo[key];
                return value === undefined ? `{{${key}}}` : this.escapeHtml(this.serializeValue(value));
            });
            return html;
        } catch {
            return null;
        }
    }

    private resolveTemplateName(options: SendMailWithTemplateOptions) {
        const templateAlias = options.template_alias?.trim();

        if (templateAlias) {
            return templateAlias;
        }

        const templateKey = options.template_key?.trim();
        const configuredAlias = this.resolveConfiguredTemplateAlias(templateKey);

        return configuredAlias || templateKey || "local-template";
    }

    private resolveConfiguredTemplateAlias(templateKey?: string) {
        if (!templateKey) {
            return undefined;
        }

        return Object.entries(emailTemplateConfig).find(
            ([, configuredTemplateKey]) => configuredTemplateKey === templateKey
        )?.[0];
    }

    private humanizeTemplateName(templateName: string) {
        return templateName
            .split(/[_-]+/)
            .filter(Boolean)
            .map(
                (part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
            )
            .join(" ");
    }

    private formatRecipients(recipients?: MailRecipient[]) {
        if (!recipients?.length) {
            return undefined;
        }

        return recipients.map((recipient) =>
            this.formatAddress(recipient.email_address)
        );
    }

    private formatReplyTo(replyTo?: MailAddress[]) {
        if (!replyTo?.length) {
            return undefined;
        }

        return replyTo.map((address) => this.formatAddress(address));
    }

    private formatAddress(address: MailAddress) {
        return address.name
            ? `${address.name} <${address.address}>`
            : address.address;
    }

    private serializeValue(value: unknown) {
        if (value === null || value === undefined) {
            return "";
        }

        if (typeof value === "string") {
            return value;
        }

        if (typeof value === "number" || typeof value === "boolean") {
            return String(value);
        }

        return JSON.stringify(value, null, 2);
    }

    private escapeHtml(value: string) {
        return value
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }
}