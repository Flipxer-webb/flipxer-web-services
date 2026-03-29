const ValidationPipeMock = jest
    .fn()
    .mockImplementation((options: Record<string, unknown>) => ({ options }));

jest.mock("@nestjs/common", () => ({
    ...jest.requireActual("@nestjs/common"),
    __esModule: true,
    ValidationPipe: ValidationPipeMock,
}));

import { WsValidationException } from "../error";
import { WsValidatorPipeInstance } from "../index";

describe("WsValidatorPipeInstance", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("creates ValidationPipe with expected options", () => {
        const pipe = WsValidatorPipeInstance() as any;

        expect(ValidationPipeMock).toHaveBeenCalledWith(
            expect.objectContaining({
                transform: true,
                whitelist: true,
                forbidNonWhitelisted: true,
                transformOptions: {
                    enableImplicitConversion: true,
                },
                exceptionFactory: expect.any(Function),
            })
        );

        expect(pipe).toEqual(
            expect.objectContaining({
                options: expect.any(Object),
            })
        );
    });

    it("maps validation errors into WsValidationException payload", () => {
        WsValidatorPipeInstance();
        const options = ValidationPipeMock.mock.calls[0][0];
        const exceptionFactory = options.exceptionFactory as Function;

        const exception = exceptionFactory([
            {
                property: "email",
                constraints: {
                    isEmail: "Email must be valid",
                },
            },
            {
                property: "username",
                constraints: undefined,
            },
        ]);

        expect(exception).toBeInstanceOf(WsValidationException);
        expect(exception.getResponse()).toEqual([
            { fieldName: "email", message: "Email must be valid" },
            { fieldName: "username", message: "Invalid input" },
        ]);
    });
});
