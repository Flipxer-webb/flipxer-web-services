import { ValidationPipe } from "@nestjs/common";

import { WsValidationException } from "./error";

export const WsValidatorPipeInstance = (): ValidationPipe => {
    return new ValidationPipe({
        exceptionFactory(errors) {
            const errorValues = errors.map((err) => {
                if (err.constraints) {
                    const [message] = Object.values(err.constraints);
                    const fieldName = err.property;
                    return { fieldName, message };
                }
                return {
                    fieldName: err.property,
                    message: "Invalid input",
                };
            });
            return new WsValidationException(errorValues);
        },
    });
};
