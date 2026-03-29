// Break circular dependency: auth/guard -> @/modules/api/user -> auth/index -> auth/controllers -> @User()
jest.mock("@/modules/api/user", () => {
    class AccountDeletedException extends Error { constructor() { super("Account deleted"); } }
    class UserNotFoundException extends Error { constructor() { super("User not found"); } }
    return {
        User: () => () => {},
        ClientData: () => () => {},
        UserModule: class { readonly __stub = true },
        AccountDeletedException,
        UserNotFoundException,
        __esModule: true,
    };
});

import * as webhookHandlers from "../webhook-handlers";

describe("webhook-handlers index", () => {
    it("re-exports concrete handler classes", () => {
        expect(webhookHandlers.DepositWebhookHandler).toBeDefined();
        expect(webhookHandlers.SwapWebhookHandler).toBeDefined();
        expect(webhookHandlers.WithdrawalWebhookHandler).toBeDefined();
    });
});// Break circular dependency: auth/guard -> @/modules/api/user -> auth/index -> auth/controllers -> @User()
jest.mock("@/modules/api/user", () => {
    class AccountDeletedException extends Error { constructor() { super("Account deleted"); } }
    class UserNotFoundException extends Error { constructor() { super("User not found"); } }
    return {
        User: () => () => {},
        ClientData: () => () => {},
        UserModule: class { readonly __stub = true },
        AccountDeletedException,
        UserNotFoundException,
        __esModule: true,
    };
});

describe("trade webhook-handlers exports", () => {
    it("exports handler classes from the webhook-handlers barrel", async () => {
        const moduleExports = await import("../webhook-handlers");

        expect(moduleExports.DepositWebhookHandler).toBeDefined();
        expect(moduleExports.SwapWebhookHandler).toBeDefined();
        expect(moduleExports.WithdrawalWebhookHandler).toBeDefined();
    });
});