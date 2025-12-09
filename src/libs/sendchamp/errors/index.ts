export class SendchampError extends Error {
    status?: number;

    constructor(message: string) {
        super(message);
        this.name = "SendchampError";
    }
}

export class SendchampAuthorizationError extends SendchampError {
    constructor(message: string = "Unauthorized - Invalid API key") {
        super(message);
        this.name = "SendchampAuthorizationError";
        this.status = 401;
    }
}

export class SendchampValidationError extends SendchampError {
    constructor(message: string = "Validation error") {
        super(message);
        this.name = "SendchampValidationError";
        this.status = 422;
    }
}

export class SendchampInsufficientBalanceError extends SendchampError {
    constructor(message: string = "Insufficient balance") {
        super(message);
        this.name = "SendchampInsufficientBalanceError";
        this.status = 402;
    }
}

export class SendchampGenericError extends SendchampError {
    constructor(message: string = "An error occurred") {
        super(message);
        this.name = "SendchampGenericError";
        this.status = 500;
    }
}
