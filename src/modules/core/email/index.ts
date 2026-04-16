import { mailConfig } from "@/config";
import { SendMailClient } from "zeptomail";
import { Global, Module } from "@nestjs/common";
import { EmailService } from "./services";
import { SmtpMailClient } from "./clients/smtp-mail.client";

@Global()
@Module({
    providers: [
        {
            provide: EmailService,
            useFactory() {
                if (process.env.MAIL_DRIVER === "smtp") {
                    return new EmailService(new SmtpMailClient());
                }
                const client: SendMailClient = new SendMailClient({
                    url: mailConfig.url,
                    token: mailConfig.token,
                });
                return new EmailService(client);
            },
        },
    ],
    exports: [EmailService],
})
export class EmailModule {}
