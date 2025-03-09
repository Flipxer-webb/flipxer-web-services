import { HttpException } from "@nestjs/common";

export class DojahException extends HttpException {
    name = "DojahException";
}
