import { WsException } from "@nestjs/websockets";

export class WsValidationException extends WsException {
    private readonly response: any;

    constructor(response: any) {
        super(response);
        this.response = response;
    }

    getResponse() {
        return this.response;
    }
}
