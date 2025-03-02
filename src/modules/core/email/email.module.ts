import { Global, Module } from "@nestjs/common";
import { EmailService } from "./services/email.service";
import * as nodemailer from "nodemailer";
import Email from "email-templates";
import { resolve } from "path";
import { mailConfig } from "@/config";
import SMTPPool from "nodemailer/lib/smtp-pool";

@Global()
@Module({
    imports: [],
    providers: [
        {
            provide: EmailService,
            useFactory() {
                const smtpTransport = nodemailer.createTransport({
                    pool: true,
                    host: mailConfig.host,
                    port: mailConfig.port,
                    secure: true, // true for 465, false for other ports
                    auth: {
                        user: mailConfig.user,
                        pass: mailConfig.pass,
                    },
                } as SMTPPool.Options);

                const email = new Email({
                    message: {
                        from: {
                            name: mailConfig.senderName,
                            address: mailConfig.senderEmail,
                        },
                    },
                    views: {
                        root: resolve("public/templates/emails"),
                        options: {
                            extension: "ejs",
                        },
                    },
                    transport: smtpTransport,
                    send: true,
                });

                return new EmailService(email);
            },
            inject: [],
        },
    ],
    exports: [EmailService],
})
export class EmailModule {}
