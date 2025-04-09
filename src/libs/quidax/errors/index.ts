export class QuidaxError extends Error {
    readonly name: string = "QuidaxError";
    status: number;
}

export class QuidaxGenericError extends QuidaxError {
    name = "QuidaxGenericError";
    status: number;
}

export class QuidaxAuthorizationError extends QuidaxError {
    name = "QuidaxAuthorizationError";
    status = 401;
}

export class QuidaxValidationError extends QuidaxError {
    name = "QuidaxValidationError";
    status = 400;
}

export class QuidaxNotFoundError extends QuidaxError {
    name = "QuidaxNotFoundError";
    status = 404;
}

export class QuidaxTooManyRequestError extends QuidaxError {
    name = "DojahTooManyRequestError";
    status = 429;
}
