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

const LOCAL_TEMPLATE_DIRECTORY = path.resolve(
    __dirname,
    "../../../../../email-templates"
);

const DOCUMENT_APPROVED_TEMPLATE_PATH = path.resolve(
    LOCAL_TEMPLATE_DIRECTORY,
    "document-approved.html"
);

const DOCUMENT_ESCALATED_TEMPLATE_PATH = path.resolve(
    LOCAL_TEMPLATE_DIRECTORY,
    "document-escalated.html"
);

const DOCUMENT_PENDING_REVIEW_TEMPLATE_PATH = path.resolve(
    LOCAL_TEMPLATE_DIRECTORY,
    "document-pending-review.html"
);

const DOCUMENT_REJECTED_TEMPLATE_PATH = path.resolve(
    LOCAL_TEMPLATE_DIRECTORY,
    "document-rejected.html"
);

const FORGOT_PASSWORD_TEMPLATE_PATH = path.resolve(
    LOCAL_TEMPLATE_DIRECTORY,
    "forgot-password.html"
);

const RECOVERY_PIN_TEMPLATE_PATH = path.resolve(
    LOCAL_TEMPLATE_DIRECTORY,
    "recovery-pin.html"
);

const REGISTRATION_SUCCESS_TEMPLATE_PATH = path.resolve(
    LOCAL_TEMPLATE_DIRECTORY,
    "registration-success.html"
);

const TRANSACTION_FAILED_TEMPLATE_PATH = path.resolve(
    LOCAL_TEMPLATE_DIRECTORY,
    "transaction-failed.html"
);

const TRANSACTION_NOTIFICATION_TEMPLATE_PATH = path.resolve(
    LOCAL_TEMPLATE_DIRECTORY,
    "transaction-notification.html"
);

const TRANSACTION_OTP_TEMPLATE_PATH = path.resolve(
    LOCAL_TEMPLATE_DIRECTORY,
    "transaction-otp.html"
);

const VERIFY_ACCOUNT_TEMPLATE_PATH = path.resolve(
    LOCAL_TEMPLATE_DIRECTORY,
    "verify-account.html"
);

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
        const templateKey =
            (options as any).mail_template_key?.trim() ??
            options.template_key?.trim();
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
                templateName,
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
                const mergeInfo = this.mergeRecipientData(
                    [recipient],
                    options.merge_info
                );

                return await this.sendMailWithTemplate({
                    ...options,
                    to: [recipient] as never,
                    merge_info: mergeInfo,
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
        const headers: Record<string, string> = {};

        if (mimeHeaders) {
            Object.assign(headers, mimeHeaders);
        }

        if (clientReference) {
            headers["X-Client-Reference"] = clientReference;
        }

        return Object.keys(headers).length > 0 ? headers : undefined;
    }

    private buildAttachments(
        attachments?: Array<{
            content?: string;
            mime_type: string;
            name: string;
        }>
    ) {
        return (attachments ?? []).flatMap((attachment) => {
            if (!attachment.content) {
                return [];
            }

            return [{
                filename: attachment.name,
                content: Buffer.from(attachment.content, "base64"),
                contentType: attachment.mime_type,
            }];
        });
    }

    private buildInlineImages(
        inlineImages?: Array<{
            mime_type: string;
            content?: string;
            cid: string;
        }>
    ) {
        return (inlineImages ?? []).flatMap((inlineImage, index) => {
            if (!inlineImage.content) {
                return [];
            }

            return [{
                filename: `inline-${index}`,
                content: Buffer.from(inlineImage.content, "base64"),
                contentType: inlineImage.mime_type,
                cid: inlineImage.cid,
            }];
        });
    }

    private mergeRecipientData(
        recipients?: MailRecipient[],
        mergeInfo?: Record<string, unknown>
    ) {
        const merged: Record<string, unknown> = mergeInfo
            ? { ...mergeInfo }
            : {};

        for (const recipient of recipients ?? []) {
            if (recipient.merge_info) {
                Object.assign(merged, recipient.merge_info);
            }
        }

        return merged;
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
        const templateContents = this.readKnownLocalTemplate(templateName);
        if (!templateContents) {
            return null;
        }

        try {
            let html = templateContents;
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

        if (templateAlias && this.isSafeTemplateName(templateAlias)) {
            return templateAlias;
        }

        const templateKey =
            (options as any).mail_template_key?.trim() ??
            options.template_key?.trim();
        const configuredAlias = this.resolveConfiguredTemplateAlias(templateKey);

        if (configuredAlias && this.isSafeTemplateName(configuredAlias)) {
            return configuredAlias;
        }

        if (templateKey && this.isSafeTemplateName(templateKey)) {
            return templateKey;
        }

        return "local-template";
    }

    private isSafeTemplateName(templateName: string) {
        return /^[a-z0-9_-]+$/i.test(templateName);
    }

    private readKnownLocalTemplate(templateName: string): string | null {
        try {
            switch (templateName.trim().toLowerCase()) {
                case "document-approved":
                case "document_approved":
                    return this.readDocumentApprovedTemplate();
                case "document-escalated":
                case "document_escalated":
                    return this.readDocumentEscalatedTemplate();
                case "document-pending-review":
                case "document_pending_review":
                    return this.readDocumentPendingReviewTemplate();
                case "document-rejected":
                case "document_rejected":
                    return this.readDocumentRejectedTemplate();
                case "forgot-password":
                case "forgot_password":
                    return this.readForgotPasswordTemplate();
                case "recovery-pin":
                case "recovery_pin":
                    return this.readRecoveryPinTemplate();
                case "registration-success":
                case "registration_success":
                    return this.readRegistrationSuccessTemplate();
                case "transaction-failed":
                case "transaction_failed":
                    return this.readTransactionFailedTemplate();
                case "transaction-notification":
                case "transaction_notification":
                    return this.readTransactionNotificationTemplate();
                case "transaction-otp":
                case "transaction_otp":
                    return this.readTransactionOtpTemplate();
                case "verify-account":
                case "verify_account":
                    return this.readVerifyAccountTemplate();
                default:
                    return null;
            }
        } catch {
            return null;
        }
    }

    private readDocumentApprovedTemplate() {
        if (!fs.existsSync(DOCUMENT_APPROVED_TEMPLATE_PATH)) {
            return null;
        }

        return fs.readFileSync(DOCUMENT_APPROVED_TEMPLATE_PATH, "utf-8");
    }

    private readDocumentEscalatedTemplate() {
        if (!fs.existsSync(DOCUMENT_ESCALATED_TEMPLATE_PATH)) {
            return null;
        }

        return fs.readFileSync(DOCUMENT_ESCALATED_TEMPLATE_PATH, "utf-8");
    }

    private readDocumentPendingReviewTemplate() {
        if (!fs.existsSync(DOCUMENT_PENDING_REVIEW_TEMPLATE_PATH)) {
            return null;
        }

        return fs.readFileSync(DOCUMENT_PENDING_REVIEW_TEMPLATE_PATH, "utf-8");
    }

    private readDocumentRejectedTemplate() {
        if (!fs.existsSync(DOCUMENT_REJECTED_TEMPLATE_PATH)) {
            return null;
        }

        return fs.readFileSync(DOCUMENT_REJECTED_TEMPLATE_PATH, "utf-8");
    }

    private readForgotPasswordTemplate() {
        if (!fs.existsSync(FORGOT_PASSWORD_TEMPLATE_PATH)) {
            return null;
        }

        return fs.readFileSync(FORGOT_PASSWORD_TEMPLATE_PATH, "utf-8");
    }

    private readRecoveryPinTemplate() {
        if (!fs.existsSync(RECOVERY_PIN_TEMPLATE_PATH)) {
            return null;
        }

        return fs.readFileSync(RECOVERY_PIN_TEMPLATE_PATH, "utf-8");
    }

    private readRegistrationSuccessTemplate() {
        if (!fs.existsSync(REGISTRATION_SUCCESS_TEMPLATE_PATH)) {
            return null;
        }

        return fs.readFileSync(REGISTRATION_SUCCESS_TEMPLATE_PATH, "utf-8");
    }

    private readTransactionFailedTemplate() {
        if (!fs.existsSync(TRANSACTION_FAILED_TEMPLATE_PATH)) {
            return null;
        }

        return fs.readFileSync(TRANSACTION_FAILED_TEMPLATE_PATH, "utf-8");
    }

    private readTransactionNotificationTemplate() {
        if (!fs.existsSync(TRANSACTION_NOTIFICATION_TEMPLATE_PATH)) {
            return null;
        }

        return fs.readFileSync(TRANSACTION_NOTIFICATION_TEMPLATE_PATH, "utf-8");
    }

    private readTransactionOtpTemplate() {
        if (!fs.existsSync(TRANSACTION_OTP_TEMPLATE_PATH)) {
            return null;
        }

        return fs.readFileSync(TRANSACTION_OTP_TEMPLATE_PATH, "utf-8");
    }

    private readVerifyAccountTemplate() {
        if (!fs.existsSync(VERIFY_ACCOUNT_TEMPLATE_PATH)) {
            return null;
        }

        return fs.readFileSync(VERIFY_ACCOUNT_TEMPLATE_PATH, "utf-8");
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
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#39;");
    }
}