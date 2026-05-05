export class DojahError extends Error {
    readonly name: string = "DojahError";
    status: number;
    responseBody?: unknown;
    requestMetadata?: Record<string, unknown> | null;
}

export class DojahGenericError extends DojahError {
    name = "DojahGenericError";
    status: number;
}

export class DojahNetworkError extends DojahError {
    name = "DojahNetworkError";
    status = 503;
}

export class DojahAuthorizationError extends DojahError {
    name = "DojahAuthorizationError";
    status = 401;
}

export class DojahValidationError extends DojahError {
    name = "DojahValidationError";
    status = 400;
}

export class DojahLowBalanceError extends DojahError {
    name = "DojahLowBalanceError";
    status = 402;
}

export class DojahNotFoundError extends DojahError {
    name = "DojahNotFoundError";
    status = 404;
}

export class DojahMethodNotFoundError extends DojahError {
    name = "DojahMethodNotFoundError";
    status = 405;
}

export class DojahRequestTimeoutError extends DojahError {
    name = "DojahRequestTimeoutError";
    status = 408;
}

export class DojahThirdPartyServiceFailureError extends DojahError {
    name = "DojahThirdPartyServiceFailureError";
    status = 424;
}

export class DojahTooManyRequestError extends DojahError {
    name = "DojahTooManyRequestError";
    status = 429;
}
