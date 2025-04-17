import { HttpException } from "@nestjs/common";

export class TradeNotfoundException extends HttpException {
    name = "TradeNotfoundException";
}
