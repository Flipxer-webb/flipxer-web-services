export class TermiiError extends Error {
    status?: number;
    constructor(message: string) {
        super(message);
        this.name = "TermiiError";
    }
}

export class TermiiAuthorizationError extends TermiiError {
    constructor(message: string = "Invalid API key") {
        super(message);
        this.name = "TermiiAuthorizationError";
        this.status = 401;
    }
}

export class TermiiValidationError extends TermiiError {
    constructor(message: string = "Validation error") {
        super(message);
        this.name = "TermiiValidationError";
        this.status = 400;
    }
}

export class TermiiInsufficientBalanceError extends TermiiError {
    constructor(message: string = "Insufficient balance") {
        super(message);
        this.name = "TermiiInsufficientBalanceError";
        this.status = 402;
    }
}

export class TermiiGenericError extends TermiiError {
    constructor(message: string = "An error occurred") {
        super(message);
        this.name = "TermiiGenericError";
    }
}
