import { HttpStatus } from "@nestjs/common";
import { APIServiceHttpException, NonApiServiceHttpException } from "../index";

describe("utils error helpers", () => {
    it("builds APIServiceHttpException with response body and status", () => {
        const payload = {
            statusCode: HttpStatus.BAD_REQUEST,
            message: "Invalid payload",
            error: "Bad Request",
        } as any;

        const exception = new APIServiceHttpException(payload, HttpStatus.BAD_REQUEST);

        expect(exception.getStatus()).toBe(HttpStatus.BAD_REQUEST);
        expect(exception.getResponse()).toEqual(payload);
    });

    it("constructs NonApiServiceHttpException as an HttpException subtype", () => {
        const exception = new NonApiServiceHttpException("Service unavailable", HttpStatus.SERVICE_UNAVAILABLE);

        expect(exception.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
        expect(exception.getResponse()).toBe("Service unavailable");
    });
});