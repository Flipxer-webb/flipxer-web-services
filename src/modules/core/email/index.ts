import { mailConfig } from "@/config";
import { SendMailClient } from "zeptomail";
import { Global, Module } from "@nestjs/common";
import { EmailService } from "./services";

@Global()
@Module({
    providers: [
        {
            provide: EmailService,
            useFactory() {
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
