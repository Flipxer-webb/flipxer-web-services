import Mail from "nodemailer/lib/mailer";

export interface SendOptions<Params extends Record<string, any>, Temp> {
    params?: Params;
    template: Temp;
    mailOptions: Mail.Options | undefined;
}
