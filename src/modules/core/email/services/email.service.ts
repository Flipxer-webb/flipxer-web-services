import { Injectable, Logger } from "@nestjs/common";
import { SendOptions } from "../types";
import Email from "email-templates";

@Injectable()
export class EmailService<
    T extends Record<string, any> = Record<string, any>,
    R = keyof T
> {
    private readonly logger = new Logger(EmailService.name);
    constructor(private readonly email: Email) {}

    async send<TParams extends Record<string, any>>(
        options: SendOptions<TParams, R>
    ) {
        try {
            return await this.email.send({
                template: options.template as any,
                message: options.mailOptions,
                locals: options.params,
            });
        } catch (error) {
            this.logger.error(error);
            if (error) {
                return false;
            }
        }
    }
}
