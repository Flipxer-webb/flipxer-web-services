const ValidationPipeMock = jest
    .fn()
    .mockImplementation((options: Record<string, unknown>) => ({ options }));

jest.mock("@nestjs/common", () => ({
    ...jest.requireActual("@nestjs/common"),
    __esModule: true,
    ValidationPipe: ValidationPipeMock,
}));

import { HttpStatus } from "@nestjs/common";
import { classValidatorPipeInstance } from "../index";
import { ValidationException } from "../error";

describe("classValidatorPipeInstance", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("builds ValidationPipe with expected options", () => {
        const pipe = classValidatorPipeInstance() as any;

        expect(ValidationPipeMock).toHaveBeenCalledWith(
            expect.objectContaining({
                whitelist: true,
                forbidNonWhitelisted: true,
                forbidUnknownValues: true,
                transform: true,
                transformOptions: { enableImplicitConversion: true },
                exceptionFactory: expect.any(Function),
            }),
        );
        expect(pipe.options).toBeDefined();
    });

    it("maps class-validator errors to ValidationException", () => {
        classValidatorPipeInstance();
        const options = ValidationPipeMock.mock.calls[0][0];
        const exceptionFactory = options.exceptionFactory as Function;

        const exception = exceptionFactory([
            {
                property: "email",
                constraints: {
                    isEmail: "Invalid email",
                },
            },
            {
                property: "firstName",
                constraints: undefined,
            },
        ]);

        expect(exception).toBeInstanceOf(ValidationException);
        expect(exception.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
        expect(exception.getResponse()).toEqual([
            { fieldName: "email", message: "Invalid email" },
            { fieldName: "firstName", message: "Invalid input" },
        ]);
    });
});