import { HttpException } from "@nestjs/common";

export class QuidaxException extends HttpException {
    name = "QuidaxException";
}
