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
    code?: string; // E.g., E0101 for "user already exists"
    
    constructor(message: string, code?: string) {
        super(message);
        this.code = code;
    }
}

export class QuidaxNotFoundError extends QuidaxError {
    name = "QuidaxNotFoundError";
    status = 404;
}

export class QuidaxTooManyRequestError extends QuidaxError {
    name = "DojahTooManyRequestError";
    status = 429;
}

function getErrorStatus(error: unknown): number | null {
    if (typeof error !== "object" || error === null) {
        return null;
    }

    if ("status" in error && typeof error.status === "number") {
        return error.status;
    }

    if ("getStatus" in error && typeof error.getStatus === "function") {
        const status = error.getStatus();
        return typeof status === "number" ? status : null;
    }

    return null;
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    if (
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof error.message === "string"
    ) {
        return error.message;
    }

    return "";
}

export function isQuidaxThrottleError(error: unknown): boolean {
    if (error instanceof QuidaxTooManyRequestError) {
        return true;
    }

    const status = getErrorStatus(error);
    return status === 429 || status === 444;
}

export function isQuidaxCloudflareBlockError(error: unknown): boolean {
    if (getErrorStatus(error) !== 403) {
        return false;
    }

    const message = getErrorMessage(error).toLowerCase();

    return (
        message.includes("cloudflare") &&
        (
            message.includes("quidax.io") ||
            message.includes("you are unable to access") ||
            message.includes("sorry, you have been blocked") ||
            message.includes("cloudflare ray id")
        )
    );
}

export function isQuidaxCooldownError(error: unknown): boolean {
    return isQuidaxThrottleError(error) || isQuidaxCloudflareBlockError(error);
}
