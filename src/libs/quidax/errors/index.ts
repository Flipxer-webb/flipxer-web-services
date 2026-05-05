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

function isQuidaxCloudflareBlock(error: {
    status?: number;
    message?: string;
}): boolean {
    if (error.status !== 403 || typeof error.message !== "string") {
        return false;
    }

    return /cloudflare|unable to access quidax\.io/i.test(error.message);
}

export function isQuidaxThrottleError(error: unknown): boolean {
    if (error instanceof QuidaxTooManyRequestError) {
        return true;
    }

    if (typeof error !== "object" || error === null) {
        return false;
    }

    if ("status" in error && typeof error.status === "number") {
        const message =
            "message" in error && typeof error.message === "string"
                ? error.message
                : undefined;

        return (
            error.status === 429 ||
            error.status === 444 ||
            isQuidaxCloudflareBlock({ status: error.status, message })
        );
    }

    if ("getStatus" in error && typeof error.getStatus === "function") {
        const status = error.getStatus();
        if (status === 429 || status === 444) {
            return true;
        }

        if (
            status === 403 &&
            "message" in error &&
            typeof error.message === "string"
        ) {
            return isQuidaxCloudflareBlock({ status, message: error.message });
        }

        return false;
    }

    return false;
}
