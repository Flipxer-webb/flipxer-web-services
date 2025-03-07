interface EmailAddress {
    address: string;
    name?: string;
}

interface Recipient {
    email_address: EmailAddress;
    merge_info?: Record<string, any>;
}

interface MailHeaders {
    [key: string]: string;
}

interface Attachment {
    content?: string; // Base64 encoded content
    mime_type: string;
    name: string;
    file_cache_key?: string; // If using ZeptoMail's file cache
}

interface InlineImage {
    mime_type: string;
    content?: string; // Base64 encoded content
    file_cache_key?: string;
    cid: string; // Content-ID for embedding images
}

export interface SendMailOptions {
    from: EmailAddress;
    to: Recipient[];
    cc?: Recipient[];
    bcc?: Recipient[];
    reply_to?: EmailAddress[];
    subject: string;
    textbody: string;
    htmlbody: string;
    track_clicks?: boolean;
    track_opens?: boolean;
    client_reference?: string;
    mime_headers?: MailHeaders;
    attachments?: Attachment[];
    inline_images?: InlineImage[];
}

export interface SendMailWithTemplateOptions {
    template_key?: string;
    template_alias?: string;
    from: EmailAddress;
    to: Recipient[];
    cc?: Recipient[];
    bcc?: Recipient[];
    reply_to?: EmailAddress[];
    merge_info?: Record<string, any>;
    client_reference?: string;
    mime_headers?: MailHeaders;
}

export interface MailBatchWithTemplateOptions
    extends SendMailWithTemplateOptions {
    to: Recipient[];
}

export interface ISendMailClient {
    sendMail(options: SendMailOptions): Promise<any>;
    sendMailWithTemplate(options: SendMailWithTemplateOptions): Promise<any>;
    mailBatchWithTemplate(options: MailBatchWithTemplateOptions): Promise<any>;
}
