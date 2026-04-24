export class AmlBotError extends Error {
    readonly name: string = "AmlBotError";
    status: number;
}

export class AmlBotGenericError extends AmlBotError {
    name = "AmlBotGenericError";
    status: number;
}

export class AmlBotNetworkError extends AmlBotError {
    name = "AmlBotNetworkError";
    status = 503;
}

export class AmlBotAuthorizationError extends AmlBotError {
    name = "AmlBotAuthorizationError";
    status = 401;
}

export class AmlBotValidationError extends AmlBotError {
    name = "AmlBotValidationError";
    status = 400;
}

export class AmlBotInsufficientBalanceError extends AmlBotError {
    name = "AmlBotInsufficientBalanceError";
    status = 402;
}

export class AmlBotRateLimitError extends AmlBotError {
    name = "AmlBotRateLimitError";
    status = 429;
}

export class AmlBotPendingError extends AmlBotError {
    name = "AmlBotPendingError";
    status = 202;
}
