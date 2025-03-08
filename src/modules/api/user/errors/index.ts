import { HttpException } from "@nestjs/common";

export class DuplicateUserException extends HttpException {
    name = "DuplicateUserException";
}

export class UserNotFoundException extends HttpException {
    name = "UserNotFoundException";
}

export class AccountDeletedException extends HttpException {
    name = "AccountDeletedException";
}
