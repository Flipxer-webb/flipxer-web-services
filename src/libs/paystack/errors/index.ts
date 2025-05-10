export class PaystackError extends Error {
    name = "PaystackError";
    status: number;
}

export class PaystackGenericError extends PaystackError {
    name = "PaystackGenericError";
    status: number;
}

export class PaystackAuthorizationError extends PaystackError {
    name = "PaystackAuthorizationError";
    status = 401;
}

export class PaystackValidationError extends PaystackError {
    name = "PaystackValidationError";
    status = 400;
}

export class PaystackNotFoundError extends PaystackError {
    name = "PaystackNotFoundError";
    status = 404;
}

export class PaystackUnprocessableError extends PaystackError {
    name = "PaystackUnprocessableError";
    status = 422;
}
