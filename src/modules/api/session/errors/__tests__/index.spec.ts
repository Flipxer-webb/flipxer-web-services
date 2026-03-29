import { HttpStatus } from "@nestjs/common";
import {
    SessionNotFoundException,
    SessionExpiredException,
    SessionRevokedException,
    InvalidSessionException,
} from "../index";

describe("Session errors", () => {
    it("uses default statuses", () => {
        expect(new SessionNotFoundException("not-found").getStatus()).toBe(HttpStatus.NOT_FOUND);
        expect(new SessionExpiredException("expired").getStatus()).toBe(HttpStatus.UNAUTHORIZED);
        expect(new SessionRevokedException("revoked").getStatus()).toBe(HttpStatus.UNAUTHORIZED);
        expect(new InvalidSessionException("invalid").getStatus()).toBe(HttpStatus.BAD_REQUEST);
    });

    it("supports custom statuses", () => {
        const notFound = new SessionNotFoundException("custom", HttpStatus.GONE);
        const expired = new SessionExpiredException("custom", HttpStatus.FORBIDDEN);
        const invalid = new InvalidSessionException("custom", HttpStatus.UNPROCESSABLE_ENTITY);

        expect(notFound.getStatus()).toBe(HttpStatus.GONE);
        expect(expired.getStatus()).toBe(HttpStatus.FORBIDDEN);
        expect(invalid.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    });

    it("returns standardized response shape", () => {
        const error = new SessionNotFoundException("missing-session");
        const response = error.getResponse() as { success: boolean; message: string };

        expect(response).toEqual({
            success: false,
            message: "missing-session",
        });
    });
});