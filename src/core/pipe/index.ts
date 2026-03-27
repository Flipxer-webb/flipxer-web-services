import { HttpStatus, ValidationPipe } from "@nestjs/common";
import { ValidationException } from "./error";

export const classValidatorPipeInstance = (): ValidationPipe => {
    return new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        forbidUnknownValues: true,
        transform: true,
        transformOptions: {
            enableImplicitConversion: true,
        },
        validationError: {
            target: false,
            value: false,
        },
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
            return new ValidationException(
                errorValues,
                HttpStatus.UNPROCESSABLE_ENTITY
            );
        },
    });
};
