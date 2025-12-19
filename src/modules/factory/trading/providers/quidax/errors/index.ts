import { HttpException } from "@nestjs/common";

export class QuidaxException extends HttpException {
    name = "QuidaxException";
    code?: string; // Quidax error code (e.g., E0101 for "user already exists")

    constructor(message: string, status: number, code?: string) {
        super(message, status);
        this.code = code;
    }
}
