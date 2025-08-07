import { HttpException } from "@nestjs/common";

export class NotificationNotFoundException extends HttpException {
    name = "NotificationNotFoundException";
}

export class NotificationException extends HttpException {
    name = "NotificationException";
}
