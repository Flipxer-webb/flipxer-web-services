import {
    AccountDeletedException,
    DuplicateUserException,
    IncorrectPasswordException,
    UserNotFoundException,
} from "../index";

describe("user error exceptions", () => {
    it("exposes stable names for each custom exception", () => {
        const duplicate = new DuplicateUserException("duplicate user", 409);
        const notFound = new UserNotFoundException("user not found", 404);
        const deleted = new AccountDeletedException("account deleted", 410);
        const wrongPassword = new IncorrectPasswordException("incorrect password", 401);

        expect(duplicate.name).toBe("DuplicateUserException");
        expect(notFound.name).toBe("UserNotFoundException");
        expect(deleted.name).toBe("AccountDeletedException");
        expect(wrongPassword.name).toBe("IncorrectPasswordException");
    });

    it("preserves message and status code", () => {
        const error = new DuplicateUserException("duplicate user", 409);

        expect(error.message).toBe("duplicate user");
        expect(error.getStatus()).toBe(409);
    });
});
